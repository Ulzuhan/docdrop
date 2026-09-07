// Command docdrop es el servicio entero: API, páginas y recursos en un binario.
//
// Sustituye al runtime de Node. Node se conserva para construir la interfaz y
// ejecutar pruebas, no para servir.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Ulzuhan/docdrop/internal/auth"
	"github.com/Ulzuhan/docdrop/internal/httpapi"
	"github.com/Ulzuhan/docdrop/internal/store"
	"github.com/Ulzuhan/docdrop/internal/uploads"
)

func main() {
	log.SetFlags(0)
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "sonda":
			if err := sonda(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		case "verificar":
			if err := verificar(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		default:
			fmt.Fprintf(os.Stderr, "uso: docdrop [sonda|verificar]\n")
			os.Exit(2)
		}
	}
	if err := servir(); err != nil {
		log.Fatalf("[docdrop] %v", err)
	}
}

// ─── Configuración ──────────────────────────────────────────────────

func entorno(nombre, porDefecto string) string {
	if v := strings.TrimSpace(os.Getenv(nombre)); v != "" {
		return v
	}
	return porDefecto
}

// bytes lee un tamaño del entorno con el mismo criterio que `envBytes` en la
// versión de Node: sólo un número finito y positivo sustituye al valor por
// defecto.
func bytes(nombre string, porDefecto int64) int64 {
	v, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(nombre)), 10, 64)
	if err != nil || v <= 0 {
		return porDefecto
	}
	return v
}

// plazoMs es un plazo en milisegundos acotado, como `boundedMs` en start.js.
func plazoMs(nombre string, porDefecto, minimo, maximo time.Duration) time.Duration {
	v, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(nombre)), 10, 64)
	if err != nil {
		return porDefecto
	}
	d := time.Duration(v) * time.Millisecond
	return min(maximo, max(minimo, d))
}

func puerto() string {
	p := entorno("PORT", "3010")
	if _, err := strconv.Atoi(p); err != nil {
		return "3010"
	}
	return p
}

func direccion() string {
	return net.JoinHostPort(entorno("HOSTNAME", "0.0.0.0"), puerto())
}

// urlValida acepta https, o http en loopback. Ni credenciales ni nada raro:
// estas dos URLs acaban en un enlace de la interfaz.
func urlValida(crudo string) string {
	return auth.URLPublicaValida(crudo)
}

// ─── Arranque ───────────────────────────────────────────────────────

func piezas() (*store.Store, *httpapi.Server, error) {
	datos := entorno("DOCDROP_DATA_DIR", "")
	if datos == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return nil, nil, err
		}
		datos = filepath.Join(cwd, ".docdrop-uploads")
	}
	almacen, err := store.Open(store.Config{
		Dir:      datos,
		MaxFile:  bytes("DOCDROP_MAX_FILE_BYTES", store.PorDefectoMaxFichero),
		MaxTotal: bytes("DOCDROP_MAX_TOTAL_BYTES", store.PorDefectoMaxTotal),
	})
	if err != nil {
		return nil, nil, err
	}

	invitados := auth.NuevosInvitados(datos, nil)
	cuentas := auth.NuevasCuentas(datos, nil)
	revocaciones := auth.NuevasRevocaciones(datos, nil)
	subidas := uploads.Nuevo(almacen, bytes("DOCDROP_CHUNK_BYTES", uploads.TrozoPorDefecto), invitados.DuenoDe)

	// Cookies Secure salvo que se pida lo contrario a mano. La versión de Node
	// lo ataba a NODE_ENV, que en un binario no existe: una variable de Node no
	// puede decidir si una cookie de sesión viaja en claro.
	seguras := strings.TrimSpace(os.Getenv("DOCDROP_INSECURE_COOKIES")) != "1"
	sesiones := auth.NuevasSesiones(os.Getenv("DOCDROP_SESSION_SECRET"), auth.TTLDeEntorno(), seguras, revocaciones, nil)
	oidc := auth.DesdeEntorno()

	// Sin cliente OIDC o sin secreto de firma no hay forma de entrar — y, a
	// diferencia del viejo modo de contraseña, tampoco hay forma de caer a un
	// servicio abierto: un endpoint de subida al alcance de cualquiera es
	// alojamiento anónimo gratis.
	if sesiones.Configurado() && oidc != nil {
		log.Println("[docdrop] sign-in: Authentik (OIDC) — accounts live there, not here")
	} else {
		log.Println("[docdrop] sign-in NOT configured: set DOCDROP_SESSION_SECRET and the " +
			"DOCDROP_OIDC_* variables, or nobody will be able to get in")
	}

	servidor := httpapi.Nuevo(httpapi.Piezas{
		Cfg: httpapi.Config{
			PublicHost:     entorno("DOCDROP_PUBLIC_HOST", ""),
			EnrollURL:      urlValida(entorno("DOCDROP_ENROLL_URL", "")),
			AccountURL:     urlValida(entorno("DOCDROP_ACCOUNT_URL", "")),
			EnlacesPie:     strings.TrimSpace(os.Getenv("KAICORP_FOOTER_LINKS")) != "",
			CookiesSeguras: seguras,
			OIDC:           oidc,
		},
		Almacen:   almacen,
		Subidas:   subidas,
		Cuentas:   cuentas,
		Invitados: invitados,
		Sesiones:  sesiones,
		Rev:       revocaciones,
	})
	log.Printf("[docdrop] data in %s · quota %s", datos, gib(almacen.MaxTotal()))
	return almacen, servidor, nil
}

func gib(n int64) string {
	return fmt.Sprintf("%.1f GiB", float64(n)/(1024*1024*1024))
}

func servir() error {
	almacen, api, err := piezas()
	if err != nil {
		return err
	}

	// El plazo por petición. Node aborta cualquier petición que dure más de
	// `requestTimeout`, 5 minutos por defecto: una subida grande es UNA sola
	// petición HTTP, así que a ~19 MB/s el corte caía sobre los 5,6 GB y un
	// fichero de 7 GB moría pasado el 80 % sin error claro en el cliente.
	// Aquí se sube igual, y por eso NO se pone WriteTimeout en el servidor: un
	// plazo global de escritura cortaría las descargas largas por la mitad.
	plazoPeticion := plazoMs("DOCDROP_REQUEST_TIMEOUT_MS", 12*time.Hour, time.Minute, 24*time.Hour)
	plazoCabeceras := plazoMs("DOCDROP_HEADERS_TIMEOUT_MS", time.Minute, 5*time.Second, 2*time.Minute)

	base, cancelarBase := context.WithCancel(context.Background())
	defer cancelarBase()

	manejador := httpapi.ConNonce(conPlazo(plazoPeticion, api))
	srv := &http.Server{
		Addr:              direccion(),
		Handler:           manejador,
		ReadHeaderTimeout: plazoCabeceras,
		IdleTimeout:       2 * time.Minute,
		BaseContext:       func(net.Listener) context.Context { return base },
		ErrorLog:          log.New(os.Stderr, "[docdrop http] ", 0),
	}

	// El barrido periódico. Sin él, un fichero caducado sólo se borraba cuando
	// alguien intentaba abrirlo: un vídeo de gigas que caducó y nadie volvió a
	// tocar se comía la cuota para siempre, hasta que las subidas nuevas
	// empezaban a fallar con «Storage full» sin que nada estuviera en uso.
	tareas, pararTareas := context.WithCancel(context.Background())
	hechoBarrido := make(chan struct{})
	go barrer(tareas, api, hechoBarrido)

	escucha, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		pararTareas()
		<-hechoBarrido
		_ = almacen.Close()
		return err
	}
	log.Printf("[docdrop] escuchando en %s · plazo por petición %s", srv.Addr, plazoPeticion)

	fallo := make(chan error, 1)
	go func() {
		if err := srv.Serve(escucha); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fallo <- err
			return
		}
		fallo <- nil
	}()

	senales := make(chan os.Signal, 1)
	signal.Notify(senales, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-fallo:
		pararTareas()
		<-hechoBarrido
		_ = almacen.Close()
		return err
	case s := <-senales:
		log.Printf("[docdrop] %s: cerrando admisión", s)
	}

	apagar(srv, api, almacen, cancelarBase, pararTareas, hechoBarrido, plazosDeEntorno())
	return nil
}

// conPlazo pone el plazo de la petición en su contexto y en los plazos del
// socket. El contexto es lo que hace que las copias en flujo se corten solas.
func conPlazo(plazo time.Duration, siguiente http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), plazo)
		defer cancel()
		rc := http.NewResponseController(w)
		limite := time.Now().Add(plazo)
		_ = rc.SetReadDeadline(limite)
		_ = rc.SetWriteDeadline(limite)
		siguiente.ServeHTTP(w, r.WithContext(ctx))
	})
}

func barrer(ctx context.Context, api *httpapi.Server, hecho chan<- struct{}) {
	defer close(hecho)
	const cada = time.Hour
	pasada := func() {
		abandonadas, borrados, invitados := api.Barrer()
		if len(abandonadas)+len(borrados)+invitados > 0 {
			log.Printf("[docdrop] sweep: %d expired, %d abandoned uploads, %d guest links",
				len(borrados), len(abandonadas), invitados)
		}
	}
	pasada()
	log.Printf("[docdrop] automatic sweep every %d min", int(cada.Minutes()))
	t := time.NewTicker(cada)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pasada()
		}
	}
}

// ─── Parada ─────────────────────────────────────────────────────────

// Plazos reparte el presupuesto de parada. Todos caben DENTRO del total: la
// lección de QR-Forge fue que 15+5 no cabe en los 10 segundos del contenedor.
type Plazos struct {
	Total       time.Duration
	Gracia      time.Duration
	Manejadores time.Duration
	Tareas      time.Duration
}

// El contenedor concede 10 s (no hay stop_grace_period declarado). Una subida
// de 7 GB no cabe en ese presupuesto y nunca cabrá, así que esto NO drena: cierra
// la admisión, deja un margen corto a lo que esté a punto de acabar y después
// corta las transferencias largas de forma controlada. Están diseñadas para
// reanudarse: una troceada continúa por los trozos que faltan y una descarga
// por Range con su continuación ya pagada.
func plazosDeEntorno() Plazos {
	total := plazoMs("DOCDROP_SHUTDOWN_MS", 8*time.Second, 200*time.Millisecond, 30*time.Second)
	return Plazos{
		Total:       total,
		Gracia:      total / 4,
		Manejadores: total / 4,
		Tareas:      total / 8,
	}
}

func apagar(srv *http.Server, api *httpapi.Server, almacen *store.Store,
	cancelarBase, pararTareas context.CancelFunc, hechoBarrido <-chan struct{}, p Plazos) {

	limite := time.Now().Add(p.Total)
	restante := func() time.Duration { return max(0, time.Until(limite)) }

	// 1. Cierre ordenado: se dejan de aceptar peticiones y se espera un margen
	//    corto a las que estén a punto de terminar.
	ctxCierre, cancelar := context.WithTimeout(context.Background(), min(p.Gracia, restante()))
	err := srv.Shutdown(ctxCierre)
	cancelar()

	if err != nil {
		// 2. Se acabó el margen: se cancelan las transferencias en curso. Cada
		//    una deja el almacén como si no hubiera existido —la descarga no
		//    cuenta y suelta su plaza, el trozo a medias no se marca, la reserva
		//    se libera— porque toda esa limpieza va en los `defer` del manejador.
		log.Printf("[docdrop] transferencias en vuelo: %d; cancelando", api.EnVuelo())
		cancelarBase()
		if !api.EsperarManejadores(min(p.Manejadores, restante())) {
			// 3. Y si aún quedan, se cortan las conexiones. Sólo entonces.
			_ = srv.Close()
			if !api.EsperarManejadores(restante()) {
				log.Printf("[docdrop] AVISO: %d manejadores no terminaron dentro del plazo; "+
					"el almacén se cierra igual", api.EnVuelo())
			}
		}
	}

	// 4. Las tareas de fondo, antes de cerrar el almacén: un barrido a medias
	//    dejaría entradas sin ficha.
	pararTareas()
	select {
	case <-hechoBarrido:
	case <-time.After(min(p.Tareas, restante())):
		log.Println("[docdrop] AVISO: el barrido no terminó dentro del plazo")
	}

	// 5. Y sólo ahora el almacén: ninguna contabilidad debe escribir después.
	if err := almacen.Close(); err != nil {
		log.Printf("[docdrop] al cerrar el almacén: %v", err)
	}
	log.Println("[docdrop] parado")
}

// ─── Subcomandos ────────────────────────────────────────────────────

// sonda es el healthcheck del contenedor: una petición a la ruta propia, que no
// pasa por el limitador ni toca el almacén.
func sonda() error {
	cliente := &http.Client{Timeout: 4 * time.Second}
	res, err := cliente.Get("http://127.0.0.1:" + puerto() + "/healthz")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz: %d", res.StatusCode)
	}
	return nil
}

// verificar recorre el almacén y dice si está coherente. Es caro, así que no lo
// hace la sonda: es para ejecutarlo a mano tras un incidente.
func verificar() error {
	almacen, _, err := piezas()
	if err != nil {
		return err
	}
	defer almacen.Close()
	metas := almacen.ListarMeta()
	fmt.Printf("%d fichas · %s ocupados de %s\n", len(metas), gib(almacen.Usado()), gib(almacen.MaxTotal()))
	problemas := 0
	for _, m := range metas {
		if m.EsLapida() {
			continue
		}
		ruta, err := almacen.RutaBlob(m.ID)
		if err != nil {
			fmt.Printf("  id inválido en el almacén: %q\n", m.ID)
			problemas++
			continue
		}
		info, err := os.Stat(ruta)
		if err != nil {
			fmt.Printf("  %s: ficha sin contenido\n", m.ID)
			problemas++
			continue
		}
		if info.Size() != m.Size {
			fmt.Printf("  %s: la ficha dice %d bytes y el fichero tiene %d\n", m.ID, m.Size, info.Size())
			problemas++
		}
	}
	if problemas > 0 {
		return fmt.Errorf("%d problemas", problemas)
	}
	fmt.Println("sin problemas")
	return nil
}
