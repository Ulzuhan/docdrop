package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// Config es lo que decide el tamaño del almacén. Los valores por defecto son
// los de `src/lib/store.ts`.
type Config struct {
	Dir      string
	MaxFile  int64
	MaxTotal int64
	Ahora    func() time.Time // reloj inyectable, para las pruebas
}

const (
	PorDefectoMaxFichero = 10 * 1024 * 1024 * 1024 // 10 GB
	PorDefectoMaxTotal   = 20 * 1024 * 1024 * 1024 // 20 GB
)

// Store es el árbol de datos. Un proceso, un escritor.
type Store struct {
	dir      string
	maxFile  int64
	maxTotal int64
	ahora    func() time.Time

	candados candados

	// Cuota: bytes ya prometidos a subidas que todavía están llegando, y caché
	// del recuento de disco. Ver cuota.go.
	cuotaMu    sync.Mutex
	reservados int64
	usadoValor int64
	usadoEn    time.Time
	usadoVale  bool

	// Plazas en vuelo y continuaciones. Ver descargas.go.
	vueloMu        sync.Mutex
	vuelo          map[string][]*plaza
	transferencias map[string]time.Time
	ultimaPurga    time.Time

	cerrado  bool
	cierreMu sync.RWMutex
}

var (
	ErrNoEncontrado = errors.New("no encontrado")
	ErrCaducado     = errors.New("caducado")
	ErrAgotado      = errors.New("agotado")
	ErrCerrado      = errors.New("el almacén está cerrado")
)

func Open(cfg Config) (*Store, error) {
	if cfg.Dir == "" {
		return nil, errors.New("el almacén necesita un directorio")
	}
	if cfg.MaxFile <= 0 {
		cfg.MaxFile = PorDefectoMaxFichero
	}
	if cfg.MaxTotal <= 0 {
		cfg.MaxTotal = PorDefectoMaxTotal
	}
	if cfg.Ahora == nil {
		cfg.Ahora = time.Now
	}
	if err := os.MkdirAll(cfg.Dir, 0o750); err != nil {
		return nil, fmt.Errorf("no se puede crear el almacén: %w", err)
	}
	return &Store{
		dir:            cfg.Dir,
		maxFile:        cfg.MaxFile,
		maxTotal:       cfg.MaxTotal,
		ahora:          cfg.Ahora,
		candados:       candados{m: map[string]*candado{}},
		vuelo:          map[string][]*plaza{},
		transferencias: map[string]time.Time{},
	}, nil
}

func (s *Store) Dir() string       { return s.dir }
func (s *Store) MaxFichero() int64 { return s.maxFile }
func (s *Store) MaxTotal() int64   { return s.maxTotal }
func (s *Store) Ahora() time.Time  { return s.ahora() }

// Close marca el almacén como cerrado. Se llama DESPUÉS de que no queden
// manejadores en vuelo (ver cmd/docdrop): una escritura posterior sería una
// contabilidad que nadie va a poder leer.
func (s *Store) Close() error {
	s.cierreMu.Lock()
	defer s.cierreMu.Unlock()
	s.cerrado = true
	return nil
}

func (s *Store) abierto() error {
	s.cierreMu.RLock()
	defer s.cierreMu.RUnlock()
	if s.cerrado {
		return ErrCerrado
	}
	return nil
}

// ─── Identificadores y rutas ────────────────────────────────────────
//
// Todo id llega de una URL, así que se valida antes de pasarlo a filepath.Join:
// sin esto, un id como "../../etc" se sale del directorio del almacén.

var reID = regexp.MustCompile(`^[0-9a-f]{12,64}$`)

func IDValido(id string) bool { return reID.MatchString(id) }

// NuevoID son 9 bytes aleatorios en hexadecimal: 18 caracteres, 72 bits.
func NuevoID() (string, error) {
	var b [9]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func (s *Store) DirEntrada(id string) (string, error) {
	if !IDValido(id) {
		return "", ErrNoEncontrado
	}
	return filepath.Join(s.dir, id), nil
}

func (s *Store) RutaBlob(id string) (string, error) {
	d, err := s.DirEntrada(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "file"), nil
}

func (s *Store) RutaMeta(id string) (string, error) {
	d, err := s.DirEntrada(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "meta.json"), nil
}

// ─── Lectura y escritura ────────────────────────────────────────────

// LeerMeta devuelve nil sin error cuando la ficha no existe o no se puede leer,
// igual que `readMeta` en Node: para quien pregunta, es un fichero que no está.
func (s *Store) LeerMeta(id string) *Meta {
	ruta, err := s.RutaMeta(id)
	if err != nil {
		return nil
	}
	datos, err := os.ReadFile(ruta)
	if err != nil {
		return nil
	}
	var m Meta
	if json.Unmarshal(datos, &m) != nil {
		return nil
	}
	return &m
}

// EscribirMeta es atómica: temporal y rename, para que un proceso que muera a
// mitad no deje una ficha ilegible. Mismo nombre de temporal que usa Node.
func (s *Store) EscribirMeta(m *Meta) error {
	if err := s.abierto(); err != nil {
		return err
	}
	destino, err := s.RutaMeta(m.ID)
	if err != nil {
		return err
	}
	datos, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := destino + ".tmp"
	if err := os.WriteFile(tmp, datos, 0o640); err != nil {
		return err
	}
	if err := os.Rename(tmp, destino); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func (s *Store) CrearEntrada(id string) error {
	d, err := s.DirEntrada(id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o750); err != nil {
		return err
	}
	s.InvalidarUsado()
	return nil
}

func (s *Store) BorrarEntrada(id string) error {
	d, err := s.DirEntrada(id)
	if err != nil {
		return nil // un id inválido no borra nada, como en Node
	}
	err = os.RemoveAll(d)
	s.InvalidarUsado()
	return err
}

// Quemar borra el contenido y deja la ficha como lápida: libera el espacio, que
// es lo que importa, y conserva el motivo para quien abra el enlace después.
func (s *Store) Quemar(id, motivo string) error {
	m := s.LeerMeta(id)
	if m == nil {
		return nil
	}
	blob, err := s.RutaBlob(id)
	if err != nil {
		return err
	}
	if err := os.Remove(blob); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s.InvalidarUsado()
	m.BurnedAt = ms(s.ahora())
	m.BurnedReason = motivo
	return s.EscribirMeta(m)
}

// ─── Recorridos ─────────────────────────────────────────────────────

func (s *Store) ids() []string {
	entradas, err := os.ReadDir(s.dir)
	if err != nil {
		return nil
	}
	var ids []string
	for _, e := range entradas {
		// "users", "guests" y "revocaciones.json" no casan con el formato de id,
		// así que este recorrido los salta sin saber que existen. Es la razón de
		// que esos nombres no sean hexadecimales.
		if IDValido(e.Name()) {
			ids = append(ids, e.Name())
		}
	}
	return ids
}

func (s *Store) ListarMeta() []Meta {
	var metas []Meta
	for _, id := range s.ids() {
		if m := s.LeerMeta(id); m != nil {
			metas = append(metas, *m)
		}
	}
	return metas
}

// sesionViva dice si la entrada es una subida troceada que todavía se puede
// reanudar. Se lee session.json a mano, sin pasar por el paquete uploads, para
// no crear una dependencia circular entre los dos.
func (s *Store) sesionViva(id string, ahora time.Time) bool {
	d, err := s.DirEntrada(id)
	if err != nil {
		return false
	}
	datos, err := os.ReadFile(filepath.Join(d, "session.json"))
	if err != nil {
		return false
	}
	var ses struct {
		SessionExpiresAt *int64 `json:"sessionExpiresAt"`
	}
	if json.Unmarshal(datos, &ses) != nil || ses.SessionExpiresAt == nil {
		return false
	}
	return *ses.SessionExpiresAt > ms(ahora)
}

// Limpiar borra lo caducado y lo agotado. Devuelve los ids retirados.
func (s *Store) Limpiar() []string {
	ahora := s.ahora()
	var borrados []string
	for _, id := range s.ids() {
		soltar := s.candados.tomar(id)
		borrado := s.limpiarEntrada(id, ahora)
		soltar()
		if borrado {
			borrados = append(borrados, id)
		}
	}
	return borrados
}

func (s *Store) limpiarEntrada(id string, ahora time.Time) bool {
	m := s.LeerMeta(id)
	if m == nil {
		// Sin ficha puede ser una subida troceada en vuelo: mientras su sesión
		// siga viva no se toca, o se borraría un fichero de gigas a mitad.
		if s.sesionViva(id, ahora) {
			return false
		}
		// Directorio huérfano de una subida interrumpida: se retira cuando se
		// ha enfriado.
		d, err := s.DirEntrada(id)
		if err != nil {
			return false
		}
		info, err := os.Stat(d)
		if err != nil {
			return false
		}
		if ahora.Sub(info.ModTime()) > time.Hour {
			return s.BorrarEntrada(id) == nil
		}
		return false
	}

	if m.EsLapida() {
		if ahora.Sub(time.UnixMilli(m.BurnedAt)) > VidaLapida {
			return s.BorrarEntrada(id) == nil
		}
		return false
	}

	if motivo := m.Motivo(ahora); motivo != "" {
		return s.Quemar(id, motivo) == nil
	}
	return false
}

// ─── Candados por clave ─────────────────────────────────────────────
//
// Serializan leer-incrementar-escribir por id, y la comprobación de cuota
// contra su creación. Sin esto, dos descargas simultáneas leen el mismo
// contador y el límite se pasa.

type candado struct {
	usos int
	mu   sync.Mutex
}

type candados struct {
	mu sync.Mutex
	m  map[string]*candado
}

// tomar bloquea la clave y devuelve la función que la suelta. El mapa se poda
// solo: una clave sin usuarios desaparece.
func (c *candados) tomar(clave string) func() {
	c.mu.Lock()
	k := c.m[clave]
	if k == nil {
		k = &candado{}
		c.m[clave] = k
	}
	k.usos++
	c.mu.Unlock()

	k.mu.Lock()
	var una sync.Once
	return func() {
		una.Do(func() {
			k.mu.Unlock()
			c.mu.Lock()
			k.usos--
			if k.usos == 0 {
				delete(c.m, clave)
			}
			c.mu.Unlock()
		})
	}
}

func (c *candados) pendientes() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.m)
}

// Pendientes son las colas por id activas. Lo usa el healthcheck para no
// afirmar que todo está en calma cuando no lo está.
func (s *Store) Pendientes() int { return s.candados.pendientes() }
