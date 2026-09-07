// Package uploads son las subidas troceadas.
//
// POR QUÉ: una subida de varios gigas en una sola petición se topa con todos
// los límites del camino —el proxy de Cloudflare rechaza cuerpos de más de
// 500 MiB, medido— y cualquier tropiezo de red obliga a empezar de cero, que en
// un teléfono es la norma: se bloquea la pantalla, el wifi pasa a datos, se cae
// la conexión.
//
// CÓMO: el cliente parte el fichero y manda cada trozo en su propia petición.
// Cada trozo se escribe directamente en su posición dentro del fichero final
// (escritura posicional), así que no hay fase de ensamblado ni espacio de disco
// duplicado. Qué trozos han llegado se lleva con ficheros marcadores vacíos,
// que son atómicos y no necesitan candado entre peticiones simultáneas.
//
//	<id>/file          fichero final, preasignado a su tamaño definitivo
//	<id>/session.json  metadatos de la subida
//	<id>/parts/<n>     marcador de «el trozo n ya está escrito»
//
// Al completar aparece <id>/meta.json y desaparecen session.json y parts/, así
// que la entrada pasa a ser un fichero normal para el resto de la aplicación.
package uploads

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/Ulzuhan/docdrop/internal/store"
)

// Cuánto se puede reanudar una subida a medias.
const VidaSesion = 24 * time.Hour

const (
	TrozoPorDefecto = 32 * 1024 * 1024
	TrozoMinimo     = 1 * 1024 * 1024
	TrozoMaximo     = 128 * 1024 * 1024
)

// Sesion es session.json tal cual. Mismo orden de campos que escribe Node.
type Sesion struct {
	ID               string `json:"id"`
	OriginalName     string `json:"originalName"`
	Size             int64  `json:"size"`
	MimeType         string `json:"mimeType"`
	TTLHours         int    `json:"ttlHours"`
	MaxDownloads     int    `json:"maxDownloads"`
	ChunkSize        int64  `json:"chunkSize"`
	TotalParts       int    `json:"totalParts"`
	CreatedAt        int64  `json:"createdAt"`
	SessionExpiresAt int64  `json:"sessionExpiresAt"`
	UploadedBy       string `json:"uploadedBy,omitempty"`
	// Quién abrió esta subida: `user:<id>` o `guest:<token>`.
	//
	// `UploadedBy` no sirve para esto: es un nombre para enseñar, lo escribe
	// quien sube y puede repetirse o estar vacío. Esto es la credencial con la
	// que se empezó, y es lo que decide quién puede seguir tocándola.
	//
	// Opcional porque las sesiones abiertas antes de que existiera no lo llevan.
	// Duran 24 horas; pasadas ésas no queda ninguna sin dueño.
	Owner string `json:"owner,omitempty"`
	// La subida es un bulto cifrado de punta a punta; pasa a la ficha al acabar.
	Encrypted bool `json:"encrypted,omitempty"`
}

// Gestor son las subidas troceadas sobre un almacén.
type Gestor struct {
	s     *store.Store
	trozo int64
	// dueñoDeInvitado resuelve `guest:<token>` al usuario que emitió el enlace.
	// Se inyecta para no crear una dependencia circular con el paquete auth.
	duenoDeInvitado func(token string) string

	mu       sync.Mutex
	bloqueos map[string]*bloqueo
}

// Los candados de una subida.
//
// POR QUÉ HACEN FALTA, con dos casos que llegaron reproducidos:
//
// DOS ESCRITURAS DEL MISMO TROZO. Cada trozo se escribe en su posición dentro
// del fichero final, así que dos peticiones del mismo índice escriben EN EL
// MISMO SITIO. Sin candado se entrelazan, y lo peor no es el desorden: una
// petición que se RECHAZA por checksum ya ha dejado sus bytes puestos. La buena
// contestaba 200, marcaba el trozo, y el fichero que alguien se descargaba
// llevaba dentro los bytes de la que se rechazó. Nadie veía un error en ningún
// momento. Medido: 32.768 bytes de basura en un trozo de 64 KiB.
//
// UN TROZO EN VUELO SOBREVIVIENDO A COMPLETAR O CANCELAR. `Completar` lee los
// marcadores, mira el tamaño del fichero y escribe la ficha; `Abortar` borra la
// entrada entera. Un trozo que siguiera escribiendo después metía bytes en un
// fichero ya terminado —con su ficha diciendo otro tamaño y su enlace ya
// repartido— y volvía a crear `parts/` dentro, que es justo la entrada con
// ficha y restos que el barrido no sabe interpretar.
//
// De ahí el reparto: cada trozo va con su candado propio, y completar o
// cancelar toman el EXCLUSIVO. Los trozos distintos siguen entrando en paralelo,
// que es lo que hace rápida una subida de gigas.
type bloqueo struct {
	usos   int
	rw     sync.RWMutex
	pmu    sync.Mutex
	partes map[int]*sync.Mutex
}

func (g *Gestor) tomar(id string) *bloqueo {
	g.mu.Lock()
	defer g.mu.Unlock()
	b := g.bloqueos[id]
	if b == nil {
		b = &bloqueo{partes: map[int]*sync.Mutex{}}
		g.bloqueos[id] = b
	}
	b.usos++
	return b
}

func (g *Gestor) soltar(id string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	b := g.bloqueos[id]
	if b == nil {
		return
	}
	b.usos--
	if b.usos == 0 {
		delete(g.bloqueos, id)
	}
}

// Parte bloquea la escritura de un trozo concreto. Devuelve la función que lo
// suelta, que va siempre en un `defer`.
//
// Toma el candado compartido de la subida —para que completar y cancelar no
// puedan colarse en medio— y el propio del índice —para que dos peticiones del
// mismo trozo no se entrelacen—.
func (g *Gestor) Parte(id string, indice int) func() {
	b := g.tomar(id)
	b.rw.RLock()

	b.pmu.Lock()
	m := b.partes[indice]
	if m == nil {
		m = &sync.Mutex{}
		b.partes[indice] = m
	}
	b.pmu.Unlock()
	m.Lock()

	var una sync.Once
	return func() {
		una.Do(func() {
			m.Unlock()
			b.rw.RUnlock()
			g.soltar(id)
		})
	}
}

// exclusivo bloquea la subida entera: no queda ningún trozo escribiendo.
func (g *Gestor) exclusivo(id string) func() {
	b := g.tomar(id)
	b.rw.Lock()
	var una sync.Once
	return func() {
		una.Do(func() {
			b.rw.Unlock()
			g.soltar(id)
		})
	}
}

func Nuevo(s *store.Store, trozo int64, duenoDeInvitado func(string) string) *Gestor {
	if trozo <= 0 {
		trozo = TrozoPorDefecto
	}
	trozo = min(max(trozo, TrozoMinimo), TrozoMaximo)
	if duenoDeInvitado == nil {
		duenoDeInvitado = func(string) string { return "" }
	}
	return &Gestor{s: s, trozo: trozo, duenoDeInvitado: duenoDeInvitado, bloqueos: map[string]*bloqueo{}}
}

func (g *Gestor) Trozo() int64 { return g.trozo }

func (g *Gestor) rutaSesion(id string) (string, error) {
	d, err := g.s.DirEntrada(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "session.json"), nil
}

func (g *Gestor) dirPartes(id string) (string, error) {
	d, err := g.s.DirEntrada(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "parts"), nil
}

// Leer devuelve nil cuando no hay sesión: para quien pregunta, no existe.
func (g *Gestor) Leer(id string) *Sesion {
	ruta, err := g.rutaSesion(id)
	if err != nil {
		return nil
	}
	datos, err := os.ReadFile(ruta)
	if err != nil {
		return nil
	}
	var s Sesion
	if json.Unmarshal(datos, &s) != nil {
		return nil
	}
	return &s
}

type Entrada struct {
	Nombre     string
	Tamano     int64
	MimeType   string
	TTLHoras   any // valor crudo: distingue ausente de null (ver store.ClampTTL)
	MaxBajadas any
	SubidoPor  any
	Owner      string
	Cifrado    bool
}

// Crear abre una subida troceada. El fichero se preasigna a su tamaño final
// para poder escribir cada trozo en su desplazamiento; en un sistema de
// ficheros con soporte de huecos no ocupa disco hasta que se rellena.
func (g *Gestor) Crear(e Entrada) (*Sesion, error) {
	id, err := store.NuevoID()
	if err != nil {
		return nil, err
	}
	ahora := g.s.Ahora()
	ses := &Sesion{
		ID:               id,
		OriginalName:     store.NombreSeguro(e.Nombre),
		Size:             e.Tamano,
		MimeType:         primero(e.MimeType, "application/octet-stream"),
		TTLHours:         store.ClampTTL(e.TTLHoras),
		MaxDownloads:     store.ClampBajadas(e.MaxBajadas),
		ChunkSize:        g.trozo,
		TotalParts:       max(1, int((e.Tamano+g.trozo-1)/g.trozo)),
		CreatedAt:        ahora.UnixMilli(),
		SessionExpiresAt: ahora.Add(VidaSesion).UnixMilli(),
		UploadedBy:       store.EtiquetaSegura(e.SubidoPor),
		Owner:            e.Owner,
		Encrypted:        e.Cifrado,
	}

	partes, err := g.dirPartes(id)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(partes, 0o750); err != nil {
		return nil, err
	}
	blob, err := g.s.RutaBlob(id)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(blob, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return nil, err
	}
	if err := f.Truncate(ses.Size); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	if err := g.escribirSesion(ses); err != nil {
		return nil, err
	}
	g.s.InvalidarUsado()
	return ses, nil
}

func (g *Gestor) escribirSesion(ses *Sesion) error {
	ruta, err := g.rutaSesion(ses.ID)
	if err != nil {
		return err
	}
	datos, err := json.MarshalIndent(ses, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(ruta, datos, 0o640)
}

// PartesRecibidas son los índices de los trozos que ya han llegado.
func (g *Gestor) PartesRecibidas(id string) []int {
	dir, err := g.dirPartes(id)
	if err != nil {
		return nil
	}
	entradas, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	indices := make([]int, 0, len(entradas))
	for _, e := range entradas {
		n, err := strconv.Atoi(e.Name())
		if err != nil || n < 0 {
			continue
		}
		indices = append(indices, n)
	}
	sort.Ints(indices)
	return indices
}

func (g *Gestor) MarcarParte(id string, indice int) error {
	dir, err := g.dirPartes(id)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, strconv.Itoa(indice)), nil, 0o640)
}

func (g *Gestor) ParteRecibida(id string, indice int) bool {
	dir, err := g.dirPartes(id)
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(dir, strconv.Itoa(indice)))
	return err == nil
}

// RangoParte es el trozo del fichero final que ocupa un índice.
func RangoParte(s *Sesion, indice int) (inicio, fin int64) {
	inicio = int64(indice) * s.ChunkSize
	fin = min(inicio+s.ChunkSize, s.Size)
	return inicio, fin
}

func TamanoParte(s *Sesion, indice int) int64 {
	inicio, fin := RangoParte(s, indice)
	return fin - inicio
}

var ErrFaltanPartes = errors.New("faltan trozos")

// Completar cierra la subida: comprueba que están todos los trozos, escribe la
// ficha y retira los restos. A partir de ahí la entrada es un fichero normal.
//
// Devuelve la lista de trozos que faltan cuando no se puede cerrar.
func (g *Gestor) Completar(ses *Sesion) (*store.Meta, []int, error) {
	// Exclusivo: no puede quedar ningún trozo escribiendo mientras se mira el
	// tamaño del fichero y se escribe la ficha.
	defer g.exclusivo(ses.ID)()

	// Ya terminada por otra petición idéntica: se devuelve su ficha en vez de
	// rehacerla. Sin esto, dos «complete» a la vez escribían dos fichas con
	// fechas de caducidad distintas para el mismo fichero.
	if m := g.s.LeerMeta(ses.ID); m != nil {
		return m, nil, nil
	}

	recibidas := map[int]bool{}
	for _, i := range g.PartesRecibidas(ses.ID) {
		recibidas[i] = true
	}
	faltan := []int{}
	for i := 0; i < ses.TotalParts; i++ {
		if !recibidas[i] {
			faltan = append(faltan, i)
		}
	}
	if len(faltan) > 0 {
		return nil, faltan, ErrFaltanPartes
	}

	blob, err := g.s.RutaBlob(ses.ID)
	if err != nil {
		return nil, nil, err
	}
	info, err := os.Stat(blob)
	if err != nil {
		return nil, nil, err
	}

	ahora := g.s.Ahora()
	// El dueño de la sesión, resuelto al terminar: `user:<id>` se queda tal
	// cual; `guest:<token>` pasa a ser de quien emitió el enlace. Una sesión sin
	// dueño (de antes de que lo llevaran) deja el fichero sin dueño: su enlace
	// funciona, el panel no lo enseña a nadie, la caducidad lo retira.
	dueno := ses.Owner
	if token, es := recortarPrefijo(dueno, "guest:"); es {
		dueno = g.duenoDeInvitado(token)
	}
	m := &store.Meta{
		ID:           ses.ID,
		OriginalName: ses.OriginalName,
		Size:         info.Size(),
		MimeType:     ses.MimeType,
		UploadedAt:   ahora.UnixMilli(),
		ExpiresAt:    ahora.Add(time.Duration(ses.TTLHours) * time.Hour).UnixMilli(),
		MaxDownloads: ses.MaxDownloads,
		UploadedBy:   ses.UploadedBy,
		Owner:        dueno,
		Encrypted:    ses.Encrypted,
	}
	if err := g.s.EscribirMeta(m); err != nil {
		return nil, nil, err
	}
	// La ficha ya está escrita: si la limpieza falla ahora, la entrada sigue
	// siendo válida y los restos los recoge el barrido — que por eso NO puede
	// borrar una entrada que ya tiene ficha (ver LimpiarSesiones).
	if dir, err := g.dirPartes(ses.ID); err == nil {
		_ = os.RemoveAll(dir)
	}
	if ruta, err := g.rutaSesion(ses.ID); err == nil {
		_ = os.Remove(ruta)
	}
	g.s.InvalidarUsado()
	return m, nil, nil
}

// Abortar cancela la subida y borra lo que hubiera llegado.
//
// Exclusivo, por lo mismo que Completar: un trozo a medio escribir cuando se
// borra la entrada volvería a crear el directorio con un fichero suelto dentro.
func (g *Gestor) Abortar(id string) error {
	if !store.IDValido(id) {
		return nil
	}
	defer g.exclusivo(id)()
	return g.s.BorrarEntrada(id)
}

// LimpiarSesiones retira las subidas a medias que nadie va a reanudar.
//
// Una entrada que YA TIENE ficha no se borra aquí, sólo se le quitan los restos.
// Sin esa comprobación, un `Completar` que escribiera la ficha y fallara al
// retirar session.json dejaba un fichero válido, con su enlace ya repartido,
// que este barrido borraba entero 24 horas después.
func (g *Gestor) LimpiarSesiones() []string {
	ahora := g.s.Ahora().UnixMilli()
	var retiradas []string
	dir := g.s.Dir()
	entradas, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	for _, e := range entradas {
		id := e.Name()
		if !store.IDValido(id) {
			continue
		}
		ses := g.Leer(id)
		if ses == nil || ses.SessionExpiresAt >= ahora {
			continue
		}
		if g.s.LeerMeta(id) != nil {
			// Subida terminada cuya limpieza no llegó a completarse: se quitan
			// los restos y se deja el fichero en paz.
			soltar := g.exclusivo(id)
			if d, err := g.dirPartes(id); err == nil {
				_ = os.RemoveAll(d)
			}
			if r, err := g.rutaSesion(id); err == nil {
				_ = os.Remove(r)
			}
			soltar()
			continue
		}
		if err := g.Abortar(id); err == nil {
			retiradas = append(retiradas, id)
		}
	}
	return retiradas
}

func primero(v, porDefecto string) string {
	if v == "" {
		return porDefecto
	}
	return v
}

func recortarPrefijo(s, prefijo string) (string, bool) {
	if len(s) >= len(prefijo) && s[:len(prefijo)] == prefijo {
		return s[len(prefijo):], true
	}
	return "", false
}
