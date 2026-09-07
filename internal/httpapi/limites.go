package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Límite de peticiones por IP, en memoria.
//
// Delante de este servicio hay un túnel sin WAF y sin límite propio, así que
// esto es lo único que hay entre el endpoint de subida y el abuso. Vive en
// memoria: se reinicia con el proceso y no vale entre instancias, pero para un
// servicio de un solo nodo hace el trabajo.

type cubo struct{ golpes []time.Time }

type Limitador struct {
	mu          sync.Mutex
	cubos       map[string]*cubo
	ultimaPurga time.Time
	ahora       func() time.Time
}

func NuevoLimitador(ahora func() time.Time) *Limitador {
	if ahora == nil {
		ahora = time.Now
	}
	return &Limitador{cubos: map[string]*cubo{}, ultimaPurga: ahora(), ahora: ahora}
}

type Resultado struct {
	Permitido  bool
	Restantes  int
	ReintentoS int
}

// Permitir es una ventana deslizante: `limite` peticiones por `ventana` para una
// clave (normalmente "acción:ip").
func (l *Limitador) Permitir(clave string, limite int, ventana time.Duration) Resultado {
	ahora := l.ahora()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.purgar(ahora)

	c := l.cubos[clave]
	if c == nil {
		c = &cubo{}
	}
	vivos := c.golpes[:0]
	for _, t := range c.golpes {
		if ahora.Sub(t) < ventana {
			vivos = append(vivos, t)
		}
	}
	c.golpes = vivos
	l.cubos[clave] = c

	if len(c.golpes) >= limite {
		espera := ventana - ahora.Sub(c.golpes[0])
		segundos := int((espera + time.Second - 1) / time.Second)
		return Resultado{Permitido: false, ReintentoS: max(1, segundos)}
	}
	c.golpes = append(c.golpes, ahora)
	return Resultado{Permitido: true, Restantes: limite - len(c.golpes)}
}

// Olvidar borra los intentos de una clave (tras un inicio de sesión correcto).
func (l *Limitador) Olvidar(clave string) {
	l.mu.Lock()
	delete(l.cubos, clave)
	l.mu.Unlock()
}

// purgar se llama con el candado puesto: sin esto el mapa crece con cada IP
// que pasa una vez y no vuelve.
func (l *Limitador) purgar(ahora time.Time) {
	if ahora.Sub(l.ultimaPurga) < time.Minute {
		return
	}
	l.ultimaPurga = ahora
	for clave, c := range l.cubos {
		if len(c.golpes) == 0 || ahora.Sub(c.golpes[len(c.golpes)-1]) > time.Hour {
			delete(l.cubos, clave)
		}
	}
}

// IPCliente es la dirección con la que se contabiliza el límite.
//
// Comprobado contra un proxy real de Tailscale (serve y funnel): SOBRESCRIBE
// X-Forwarded-For con la IP de origen y descarta lo que mandara el cliente, así
// que la cabecera es de fiar cuando hay un proxy delante. Se toma el ÚLTIMO
// elemento de la lista, que es siempre el que escribe el proxy más cercano.
//
// X-Real-Ip no se usa como respaldo a propósito: Tailscale NO la quita y un
// cliente puede inventársela, lo que permitiría cambiar de identidad en cada
// petición y esquivar el límite. Sin proxy (acceso directo al puerto) todas las
// peticiones caen en el mismo cubo, que es lo prudente.
func IPCliente(r *http.Request) string {
	if xff := r.Header.Get("x-forwarded-for"); xff != "" {
		partes := strings.Split(xff, ",")
		for i := len(partes) - 1; i >= 0; i-- {
			if p := strings.TrimSpace(partes[i]); p != "" {
				return p
			}
		}
	}
	return "direct"
}

func demasiadas(w http.ResponseWriter, res Resultado) {
	w.Header().Set("Retry-After", strconv.Itoa(res.ReintentoS))
	escribirJSON(w, http.StatusTooManyRequests, map[string]any{"error": "Too many requests. Slow down."})
}

// ─── Origen ─────────────────────────────────────────────────────────

// mutacionDelMismoOrigen es la frontera CSRF del navegador para las mutaciones
// simples, que no disparan preflight.
//
// Se toma `Host` y no `X-Forwarded-Host`, y la diferencia importa: la segunda la
// escribe quien llama y este despliegue NO la reemplaza. Comprobado en vivo
// contra el túnel: llega intacta mientras `Host` sigue valiendo el nombre de
// verdad. Prefiriendo la primera, los guardianes se saltaban solos —cerrar la
// sesión, lanzar la purga y escribir bytes elegidos por quien llama—, que es
// exactamente lo que esto existe para impedir.
//
// DOCDROP_PUBLIC_HOST queda para el caso contrario: un proxy que reescriba
// `Host` con el nombre interno.
func (s *Server) mutacionDelMismoOrigen(r *http.Request) bool {
	// Fetch Metadata primero: dos subdominios del mismo dominio son `same-site`
	// para el navegador y la cookie viaja igual, que es el caso que hay aquí.
	if sitio := r.Header.Get("sec-fetch-site"); sitio != "" && sitio != "same-origin" && sitio != "none" {
		return false
	}
	origen := r.Header.Get("origin")
	// Sin `Origin` no hay navegador detrás, y sin navegador no hay cookie ajena
	// que aprovechar. Es lo que deja pasar a curl y a las suites.
	if origen == "" {
		return true
	}
	host := s.cfg.PublicHost
	if host == "" {
		host = r.Host
	}
	if host == "" {
		return false
	}
	return origen == s.esquema(r)+"://"+host
}

// esquema es el protocolo por el que llegó la petición. Detrás del túnel llega
// por HTTP con X-Forwarded-Proto puesto.
func (s *Server) esquema(r *http.Request) string {
	if p := r.Header.Get("x-forwarded-proto"); p != "" {
		return strings.ToLower(strings.TrimSpace(strings.Split(p, ",")[0]))
	}
	if r.TLS != nil {
		return "https"
	}
	if s.cfg.CookiesSeguras {
		return "https"
	}
	return "http"
}

// ─── Cuerpos JSON ───────────────────────────────────────────────────

var reTipoJSON = regexp.MustCompile(`(?i)^application/json\s*(;|$)`)

// Un cuerpo JSON de estas rutas son unos cientos de bytes. 64 KiB es holgado.
const limiteCuerpoJSON = 64 * 1024

// cuerpoJSON lee el cuerpo como objeto, o devuelve nil.
//
// El texto `null` es JSON válido, así que un `try/catch` no basta: devolvía
// `null` y quien luego leía un campo se llevaba un 500. Las listas tampoco
// valen: `[1,2]` creaba un enlace de invitado con todo por defecto, que es
// aceptar una petición sin sentido en vez de decir que no se entiende.
//
// Y se exige `application/json`. Los servicios de este dominio son el MISMO
// sitio para el navegador, así que la cookie de sesión viaja en una petición
// lanzada desde una página de cualquiera de ellos; el navegador sólo deja salir
// una petición a otro sitio sin preguntar antes si el tipo es `text/plain`,
// `multipart/form-data` o el de un formulario. Con `application/json` está
// obligado a preguntar, y esa pregunta aquí no se contesta.
func cuerpoJSON(r *http.Request) map[string]any {
	tipo := strings.TrimSpace(r.Header.Get("content-type"))
	if !reTipoJSON.MatchString(tipo) {
		return nil
	}
	datos, err := io.ReadAll(io.LimitReader(r.Body, limiteCuerpoJSON+1))
	if err != nil || len(datos) > limiteCuerpoJSON {
		return nil
	}
	var v any
	if json.Unmarshal(datos, &v) != nil {
		return nil
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return obj
}

func escribirJSON(w http.ResponseWriter, estado int, v any) {
	datos, err := json.Marshal(v)
	if err != nil {
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(estado)
	_, _ = w.Write(datos)
}

func errorJSON(w http.ResponseWriter, estado int, mensaje string) {
	escribirJSON(w, estado, map[string]any{"error": mensaje})
}
