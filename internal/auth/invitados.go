package auth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Ulzuhan/docdrop/internal/store"
)

// Enlaces de subida para invitados.
//
// La sesión mantiene privado el subir, pero el sentido del servicio es RECIBIR
// ficheros grandes DE otras personas — y repartir la credencial a todo el que
// alguna vez necesite mandar algo es cómo una credencial deja de serlo. Un
// enlace de invitado es la alternativa acotada: se emite desde el panel, se
// comparte /guest/<token>, y quien lo tenga puede subir (y sólo subir) hasta
// que el enlace caduque o se revoque.
//
// El token de 128 bits de la URL es toda la credencial — el mismo modelo de
// confianza que los ids de descarga de 72 bits, con más margen porque éste
// acepta escrituras.
//
// Un fichero JSON por enlace bajo <DATA>/guests/. "guests" no casa con el
// formato de id, así que los recorridos del almacén ya se saltan el directorio.

// CabeceraInvitado es lo que manda el cliente invitado en cada subida.
const CabeceraInvitado = "x-docdrop-guest"

const (
	MinTTLEnlaceHoras = 1
	MaxTTLEnlaceHoras = 7 * 24
	// Techo del TTL de los ficheros que entran por un enlace de invitado. El
	// dueño puede guardar algo 30 días; un invitado no puede llenar el almacén
	// con ficheros de un mes.
	MaxTTLFicheroInvitadoHoras = 72
)

type Enlace struct {
	Token string `json:"token"`
	// Informativo: para quién se hizo. Sale como etiqueta de quien sube.
	Label     string `json:"label,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	// Informativo, se actualiza a lo que salga (ver Anotar).
	UploadCount int `json:"uploadCount"`
	// Quién lo emitió (`user.id`). Es lo que hace que un fichero subido por el
	// enlace aparezca en el panel de quien lo repartió —y de nadie más— y que
	// nadie pueda listar ni revocar los enlaces de otro. Ausente en los
	// emitidos antes de este campo: ésos no se enseñan a nadie y caducan solos.
	CreatedBy string `json:"createdBy,omitempty"`
}

// 32 caracteres hexadecimales = 128 bits. También es la comprobación de
// seguridad de ruta antes de un Join: un token llega de una URL o de una
// cabecera y no puede salirse del directorio.
var reToken = regexp.MustCompile(`^[0-9a-f]{32}$`)

func TokenValido(t string) bool { return reToken.MatchString(t) }

type Invitados struct {
	dir   string
	ahora func() time.Time
}

func NuevosInvitados(base string, ahora func() time.Time) *Invitados {
	if ahora == nil {
		ahora = time.Now
	}
	return &Invitados{dir: filepath.Join(base, "guests"), ahora: ahora}
}

func (g *Invitados) ruta(token string) (string, bool) {
	if !TokenValido(token) {
		return "", false
	}
	return filepath.Join(g.dir, token+".json"), true
}

// Leer devuelve el enlace aunque ya haya caducado: revocarlo necesita poder
// mirarlo.
func (g *Invitados) Leer(token string) *Enlace {
	ruta, ok := g.ruta(token)
	if !ok {
		return nil
	}
	datos, err := os.ReadFile(ruta)
	if err != nil {
		return nil
	}
	var e Enlace
	if json.Unmarshal(datos, &e) != nil {
		return nil
	}
	return &e
}

func (g *Invitados) escribir(e *Enlace) error {
	ruta, ok := g.ruta(e.Token)
	if !ok {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(g.dir, 0o750); err != nil {
		return err
	}
	datos, err := json.MarshalIndent(e, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(ruta, datos, 0o640)
}

// ClampTTLEnlace acota las horas de vida del enlace igual que Node.
func ClampTTLEnlace(v any) int {
	n := store.ClampTTLGenerico(v, 24, MinTTLEnlaceHoras, MaxTTLEnlaceHoras)
	return n
}

func (g *Invitados) Crear(ttlHoras any, etiqueta any, emisor string) (*Enlace, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, err
	}
	ahora := g.ahora()
	e := &Enlace{
		Token:     hex.EncodeToString(b[:]),
		Label:     store.EtiquetaSegura(etiqueta),
		CreatedAt: ahora.UnixMilli(),
		ExpiresAt: ahora.Add(time.Duration(ClampTTLEnlace(ttlHoras)) * time.Hour).UnixMilli(),
		CreatedBy: emisor,
	}
	if err := g.escribir(e); err != nil {
		return nil, err
	}
	return e, nil
}

// Valido es el enlace si todavía sirve. Uno caducado se borra al pasar, así que
// el directorio se limpia solo con el uso; el barrido periódico recoge los que
// nadie vuelve a pedir.
func (g *Invitados) Valido(token string) *Enlace {
	e := g.Leer(token)
	if e == nil {
		return nil
	}
	if e.ExpiresAt < g.ahora().UnixMilli() {
		if ruta, ok := g.ruta(token); ok {
			_ = os.Remove(ruta)
		}
		return nil
	}
	return e
}

// Listar son los enlaces activos, los más nuevos primero.
func (g *Invitados) Listar() []Enlace {
	entradas, err := os.ReadDir(g.dir)
	if err != nil {
		return nil
	}
	enlaces := []Enlace{}
	for _, entrada := range entradas {
		token := strings.TrimSuffix(entrada.Name(), ".json")
		if e := g.Valido(token); e != nil {
			enlaces = append(enlaces, *e)
		}
	}
	sort.SliceStable(enlaces, func(i, j int) bool { return enlaces[i].CreatedAt > enlaces[j].CreatedAt })
	return enlaces
}

// Revocar borra el enlace. Dice si existía.
func (g *Invitados) Revocar(token string) bool {
	ruta, ok := g.ruta(token)
	if !ok {
		return false
	}
	_, err := os.Stat(ruta)
	existia := err == nil
	_ = os.Remove(ruta)
	return existia
}

// Anotar sube el contador de subidas del enlace. Leer-modificar-escribir a lo
// que salga: dos subidas a la vez pueden perder un incremento, y está bien —el
// contador es una pista del panel, no contabilidad—. Serializarlo no compensa
// un candado.
func (g *Invitados) Anotar(token string) {
	e := g.Leer(token)
	if e == nil {
		return
	}
	e.UploadCount++
	_ = g.escribir(e)
}

// Limpiar retira los enlaces caducados. Devuelve cuántos.
func (g *Invitados) Limpiar() int {
	entradas, err := os.ReadDir(g.dir)
	if err != nil {
		return 0
	}
	ahora := g.ahora().UnixMilli()
	retirados := 0
	for _, entrada := range entradas {
		token := strings.TrimSuffix(entrada.Name(), ".json")
		e := g.Leer(token)
		if e != nil && e.ExpiresAt < ahora {
			if ruta, ok := g.ruta(token); ok {
				_ = os.Remove(ruta)
			}
			retirados++
		}
	}
	return retirados
}

// DuenoDe es a quién pertenece lo que entre por este enlace: a quien lo emitió.
// Devuelve "" si el enlace es de antes de que llevaran emisor — ese fichero no
// será de nadie y no se enseñará a nadie, pero su enlace directo funciona.
func (g *Invitados) DuenoDe(token string) string {
	e := g.Leer(token)
	if e == nil || e.CreatedBy == "" {
		return ""
	}
	return "user:" + e.CreatedBy
}
