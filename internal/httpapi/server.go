// Package httpapi son las rutas, las páginas y las cabeceras.
package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Ulzuhan/docdrop/internal/auth"
	"github.com/Ulzuhan/docdrop/internal/store"
	"github.com/Ulzuhan/docdrop/internal/uploads"
	"github.com/Ulzuhan/docdrop/internal/web"
)

type Config struct {
	PublicHost     string
	EnrollURL      string
	AccountURL     string
	EnlacesPie     bool
	CookiesSeguras bool
	OIDC           *auth.Config
}

type Server struct {
	cfg       Config
	almacen   *store.Store
	subidas   *uploads.Gestor
	cuentas   *auth.Cuentas
	invitados *auth.Invitados
	sesiones  *auth.Sesiones
	rev       *auth.Revocaciones
	disc      *auth.Discovery
	verif     *auth.Verificador
	limites   *Limitador
	mux       *http.ServeMux
	ahora     func() time.Time
	recursos  web.Recursos
	estaticos http.Handler

	// Manejadores en vuelo, para que la parada pueda esperarlos antes de cerrar
	// el almacén: un `Hecho()` que escriba después del cierre es contabilidad
	// que nadie va a poder leer.
	enVuelo  atomic.Int64
	sinVuelo chan struct{}
	unaVez   sync.Once
}

type Piezas struct {
	Cfg       Config
	Almacen   *store.Store
	Subidas   *uploads.Gestor
	Cuentas   *auth.Cuentas
	Invitados *auth.Invitados
	Sesiones  *auth.Sesiones
	Rev       *auth.Revocaciones
	Ahora     func() time.Time
}

func Nuevo(p Piezas) *Server {
	if p.Ahora == nil {
		p.Ahora = time.Now
	}
	s := &Server{
		cfg:       p.Cfg,
		almacen:   p.Almacen,
		subidas:   p.Subidas,
		cuentas:   p.Cuentas,
		invitados: p.Invitados,
		sesiones:  p.Sesiones,
		rev:       p.Rev,
		disc:      auth.NuevoDiscovery(),
		verif:     auth.NuevoVerificador(),
		limites:   NuevoLimitador(p.Ahora),
		ahora:     p.Ahora,
		sinVuelo:  make(chan struct{}),
	}
	// Sin construcción de vite el binario sigue sirviendo la API: es lo que
	// permite pasarle las suites sin pasar antes por el frontend.
	recursos, err := web.Cargar()
	if err != nil {
		avisar("[docdrop] no se pudo leer el manifiesto del build: %v", err)
	}
	s.recursos = recursos
	estaticos, err := web.Estaticos()
	if err != nil {
		avisar("[docdrop] no se pudieron abrir los recursos: %v", err)
		estaticos = http.NotFoundHandler()
	}
	s.estaticos = estaticos
	s.rutas()
	return s
}

func (s *Server) rutas() {
	m := http.NewServeMux()

	// ── API ──────────────────────────────────────────────────────────
	m.HandleFunc("POST /api/upload", s.subir)
	m.HandleFunc("POST /api/upload/init", s.iniciarTroceada)
	m.HandleFunc("GET /api/upload/{uploadId}", s.estadoTroceada)
	m.HandleFunc("DELETE /api/upload/{uploadId}", s.cancelarTroceada)
	m.HandleFunc("PUT /api/upload/{uploadId}/part/{index}", s.subirTrozo)
	m.HandleFunc("POST /api/upload/{uploadId}/complete", s.completarTroceada)

	m.HandleFunc("GET /api/download/{id}", s.descargar)
	m.HandleFunc("GET /api/info/{id}", s.info)
	m.HandleFunc("GET /api/zip", s.zip)

	m.HandleFunc("GET /api/files", s.listarFicheros)
	m.HandleFunc("DELETE /api/files/{id}", s.borrarFichero)
	m.HandleFunc("POST /api/cleanup", s.limpiar)

	m.HandleFunc("GET /api/guest-links", s.listarInvitados)
	m.HandleFunc("POST /api/guest-links", s.crearInvitado)
	m.HandleFunc("DELETE /api/guest-links/{token}", s.revocarInvitado)
	m.HandleFunc("GET /api/guest/{token}", s.comprobarInvitado)

	m.HandleFunc("GET /api/auth/login", s.login)
	m.HandleFunc("GET /api/auth/callback", s.callback)
	m.HandleFunc("POST /api/auth/logout", s.logout)
	m.HandleFunc("POST /api/auth/backchannel-logout", s.backchannel)

	// ── Páginas y recursos ───────────────────────────────────────────
	m.HandleFunc("GET /{$}", s.paginaInicio)
	m.HandleFunc("GET /d/{id}", s.paginaDescarga)
	m.HandleFunc("GET /guest/{token}", s.paginaInvitado)
	m.HandleFunc("POST /share", s.compartir)
	m.HandleFunc("GET /share", s.compartirGet)
	m.HandleFunc("GET /robots.txt", s.robots)
	m.HandleFunc("GET /sitemap.xml", s.sitemap)
	m.HandleFunc("GET /manifest.webmanifest", s.manifiesto)
	m.HandleFunc("GET /healthz", s.salud)

	// Lo demás son recursos del build o un 404. NO hay respaldo de SPA: una
	// ruta de API que no existe tiene que seguir siendo 404, no un 200 con HTML.
	m.HandleFunc("/", s.estaticoO404)

	s.mux = m
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.enVuelo.Add(1)
	defer func() {
		if s.enVuelo.Add(-1) == 0 {
			select {
			case <-s.sinVuelo:
			default:
			}
		}
	}()

	s.cabeceras(w, r)
	s.mux.ServeHTTP(w, r)
}

// EnVuelo son las peticiones que se están atendiendo ahora mismo.
func (s *Server) EnVuelo() int64 { return s.enVuelo.Load() }

// EsperarManejadores espera a que no quede ninguna petición en vuelo, o a que
// venza el plazo. Devuelve false si venció.
//
// Existe porque `Shutdown` puede rendirse por plazo y `Close` corta las
// conexiones sin esperar al manejador: cerrar el almacén ahí dejaría una
// escritura de contabilidad a medio camino.
//
// El reloj es el de pared a propósito, y no el inyectable del almacén: esto es
// una espera real de la parada, no tiempo de dominio. Mezclarlos dejaba la
// espera colgada para siempre en cuanto el reloj de dominio iba adelantado.
func (s *Server) EsperarManejadores(plazo time.Duration) bool {
	limite := time.Now().Add(plazo)
	for {
		if s.enVuelo.Load() == 0 {
			return true
		}
		if !time.Now().Before(limite) {
			return false
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ─── Cabeceras comunes ──────────────────────────────────────────────

// La política de contenido lleva un nonce por respuesta.
//
// Antes vivía en la configuración del build con `script-src 'self'
// 'unsafe-inline'`, que es tanto como no tenerla para lo que más importa:
// 'unsafe-inline' permite ejecutar cualquier script inyectado en el HTML, que
// es exactamente el ataque del que una CSP debería proteger.
//
// Sobre el beacon de analítica: con 'strict-dynamic' el navegador IGNORA la
// lista de dominios, así que listarlo no serviría de nada. No hace falta:
// Cloudflare lo inyecta con el nonce de la página cuando ve uno.
func (s *Server) csp(nonce string) string {
	idp := ""
	if s.cfg.OIDC != nil && s.cfg.OIDC.PublicOrigin != "" {
		idp = " " + s.cfg.OIDC.PublicOrigin
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self' 'nonce-" + nonce + "' 'strict-dynamic'",
		// Los atributos de estilo de los componentes siguen necesitándolo; la
		// ejecución de scripts ya no.
		"style-src 'self' 'unsafe-inline'",
		// `blob:` es para las previsualizaciones de lo que se va a subir.
		"img-src 'self' data: blob:",
		"font-src 'self'",
		"connect-src 'self'" + idp + " https://cloudflareinsights.com",
		"form-action 'self'" + idp,
		"worker-src 'self' blob:",
		"manifest-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
		"upgrade-insecure-requests",
	}, "; ")
}

func (s *Server) cabeceras(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	// Un año de HSTS: detrás del túnel el acceso es siempre HTTPS.
	h.Set("Strict-Transport-Security", "max-age=31536000")
	// La CSP acompaña a todas las respuestas, como en la versión de Node: la
	// del proxy se ponía en la petición y en la respuesta.
	h.Set("Content-Security-Policy", s.csp(nonceDe(r)))
}

type claveNonce struct{}

// ConNonce mete un nonce nuevo en el contexto de cada petición. Va como
// middleware exterior para que la CSP de la respuesta y el `<script>` de la
// página usen exactamente el mismo.
func ConNonce(siguiente http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b [16]byte
		if _, err := rand.Read(b[:]); err != nil {
			log.Printf("[docdrop] no se pudo generar el nonce: %v", err)
			http.Error(w, "internal", http.StatusInternalServerError)
			return
		}
		nonce := base64.StdEncoding.EncodeToString(b[:])
		siguiente.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), claveNonce{}, nonce)))
	})
}

func nonceDe(r *http.Request) string {
	n, _ := r.Context().Value(claveNonce{}).(string)
	return n
}
