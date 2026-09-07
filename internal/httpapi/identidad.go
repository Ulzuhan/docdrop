package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Ulzuhan/docdrop/internal/auth"
	"github.com/Ulzuhan/docdrop/internal/store"
)

// Quién viene en esta petición, y qué puede hacer.
//
// El modelo de acceso, tal cual está en la versión de Node:
//
//	PÚBLICO    /d/<id>, /api/info/<id>, /api/download/<id>
//	           El id de 72 bits del enlace es el secreto. Permite compartir un
//	           fichero con alguien sin darle una cuenta.
//	INVITADO   /guest/<token> y subir con ese token
//	           Para gente de fuera del grupo que necesita mandar algo.
//	CON SESIÓN /, /api/upload, /api/files, /api/cleanup
//	           Subir, listar lo propio y purgar necesitan cuenta.

// usuarioActual mira la cookie y BUSCA la ficha en disco: una cuenta borrada
// deja de funcionar en el acto, no cuando caduque su cookie.
func (s *Server) usuarioActual(r *http.Request) *auth.Usuario {
	c, err := r.Cookie(auth.CookieSesion)
	if err != nil {
		return nil
	}
	uid := s.sesiones.UsuarioDe(c.Value)
	if uid == "" {
		return nil
	}
	return s.cuentas.PorID(uid)
}

// exigirSesion escribe el 401 y devuelve false si no hay sesión.
func (s *Server) exigirSesion(w http.ResponseWriter, r *http.Request) bool {
	if s.usuarioActual(r) != nil {
		return true
	}
	errorJSON(w, http.StatusUnauthorized, "Unauthorized")
	return false
}

// invitadoDe es el enlace de invitado que autoriza esta petición, si vino uno
// válido.
func (s *Server) invitadoDe(r *http.Request) *auth.Enlace {
	token := strings.ToLower(strings.TrimSpace(r.Header.Get(auth.CabeceraInvitado)))
	if token == "" {
		return nil
	}
	return s.invitados.Valido(token)
}

// exigirAccesoSubida autoriza una subida: la sesión del dueño o un token de
// invitado vivo. Mismo contrato que exigirSesion.
func (s *Server) exigirAccesoSubida(w http.ResponseWriter, r *http.Request) bool {
	if s.usuarioActual(r) != nil || s.invitadoDe(r) != nil {
		return true
	}
	errorJSON(w, http.StatusUnauthorized, "Unauthorized")
	return false
}

// credencialDe dice CON QUÉ viene esta petición: `user:<id>`, `guest:<token>`
// o "".
//
// Existe porque tener acceso y ser el dueño de una subida concreta son dos
// cosas distintas, y hasta hace poco se trataban como una. Comprobado antes de
// arreglarlo, con dos enlaces de invitado distintos: el segundo escribía el
// trozo 0 del fichero que estaba subiendo el primero, le leía el nombre del
// documento y le cancelaba la subida.
func (s *Server) credencialDe(r *http.Request) string {
	if u := s.usuarioActual(r); u != nil {
		return "user:" + u.ID
	}
	if g := s.invitadoDe(r); g != nil {
		return "guest:" + g.Token
	}
	return ""
}

// esDueno dice si quien llama puede tocar ESTA subida.
//
// Una sesión sin dueño es de antes de que esto existiera: se deja pasar para no
// romper las subidas en vuelo al desplegar. Duran 24 horas, así que pasado ese
// plazo no queda ninguna.
func esDueno(dueno, credencial string) bool {
	if dueno == "" {
		return true
	}
	return credencial != "" && dueno == credencial
}

// ─── Rutas de identidad ─────────────────────────────────────────────

const cookieOIDC = "docdrop_oidc"

type estadoLogin struct {
	Verifier string `json:"verifier"`
	State    string `json:"state"`
	Next     string `json:"next"`
}

// GET /api/auth/login — empieza el inicio de sesión contra el proveedor.
//
// El verificador PKCE, el `state` anti-CSRF y a dónde volver van en una cookie
// corta. Una cookie y no estado en el servidor porque todavía no hay sesión:
// esto pasa antes de saber quién pregunta.
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if s.cfg.OIDC == nil {
		errorJSON(w, http.StatusServiceUnavailable, "Sign-in is not configured on this instance")
		return
	}
	verificador, err1 := auth.Aleatorio()
	estado, err2 := auth.Aleatorio()
	if err1 != nil || err2 != nil {
		errorJSON(w, http.StatusInternalServerError, "Sign-in unavailable")
		return
	}
	// Sólo rutas internas: sin esto, un enlace con ?next=https://otro-sitio
	// convertiría el inicio de sesión en un redirector a donde quisiera quien
	// mandara el enlace.
	siguiente := auth.SafeNext(r.URL.Query().Get("next"))

	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.OIDC.Timeout)
	defer cancel()
	destino, err := s.disc.URLAutorizacion(ctx, s.cfg.OIDC, estado, auth.Desafio(verificador))
	if err != nil {
		errorJSON(w, http.StatusServiceUnavailable, "Sign-in is not reachable right now")
		return
	}
	datos, _ := json.Marshal(estadoLogin{Verifier: verificador, State: estado, Next: siguiente})
	// El valor va escapado como componente de URL, que es lo que hace Next al
	// poner una cookie: el JSON lleva comillas, y `net/http` las tira al
	// serializar —dejando un JSON roto que luego no se puede leer—. Escaparlo
	// además conserva la compatibilidad: un inicio de sesión empezado contra
	// Node puede terminar contra Go, y al revés.
	http.SetCookie(w, s.sesiones.CookieTemporal(cookieOIDC, store.CodificarComponente(string(datos)), 10*time.Minute))
	http.Redirect(w, r, destino, http.StatusFound)
}

// GET /api/auth/callback — la vuelta desde el proveedor.
//
// Canjea el código por una identidad, la refleja en local y abre la sesión.
// Lo que no cuadre acaba en la portada sin sesión: sin error detallado, porque
// quien llega aquí con parámetros inventados no se ha ganado la pista.
func (s *Server) callback(w http.ResponseWriter, r *http.Request) {
	if s.cfg.OIDC == nil {
		volver(w, "/")
		return
	}
	fallo := func() {
		http.SetCookie(w, s.sesiones.CookieTemporal(cookieOIDC, "", -time.Second))
		volver(w, "/?error=signin")
	}

	codigo := r.URL.Query().Get("code")
	estado := r.URL.Query().Get("state")
	var guardado estadoLogin
	if c, err := r.Cookie(cookieOIDC); err == nil {
		if crudo, ok := decodificarComponente(c.Value); ok {
			_ = json.Unmarshal([]byte(crudo), &guardado)
		}
	}
	// El `state` tiene que ser el que emitimos: es lo que impide que alguien nos
	// haga iniciar sesión con SU código.
	if codigo == "" || estado == "" || guardado.State == "" || guardado.Verifier == "" || estado != guardado.State {
		fallo()
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.OIDC.Timeout)
	defer cancel()
	identidad, err := s.disc.Canjear(ctx, s.cfg.OIDC, codigo, guardado.Verifier)
	if err != nil {
		avisar("[oidc callback] %v", err)
		fallo()
		return
	}
	usuario, err := s.cuentas.Registrar(identidad)
	if err != nil {
		avisar("[oidc callback] no se pudo guardar la cuenta: %v", err)
		fallo()
		return
	}
	token := s.sesiones.Crear(usuario.ID)
	if token == "" {
		fallo()
		return
	}
	http.SetCookie(w, s.sesiones.Cookie(token))
	http.SetCookie(w, s.sesiones.CookieTemporal(cookieOIDC, "", -time.Second))
	volver(w, auth.SafeNext(guardado.Next))
}

// volver redirige a un destino RELATIVO.
//
// Construir uno absoluto desde la URL de la petición da "localhost" en vez del
// nombre por el que llegó: el navegador aterriza en otro origen, no manda la
// cookie de sesión recién puesta, y el inicio de sesión parece roto. Un
// `Location` relativo lo resuelve el navegador contra donde ya está, así que
// funciona detrás del túnel, por Tailscale y en localhost igual.
func volver(w http.ResponseWriter, ruta string) {
	w.Header().Set("Location", ruta)
	w.WriteHeader(http.StatusFound)
}

// POST /api/auth/logout — cierra la sesión de verdad.
//
// Borrar la cookie de aquí no basta: la sesión del proveedor seguiría viva, así
// que pulsar «Sign in» volvería a entrar SIN pedir credenciales. En un
// ordenador compartido eso es peor que no tener botón. Por eso se devuelve
// además el `end-session` del proveedor, y el navegador va allí.
//
// Sigue siendo POST y no GET: con GET, una imagen en cualquier página podría
// cerrarte la sesión desde fuera.
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if !s.mutacionDelMismoOrigen(r) {
		errorJSON(w, http.StatusForbidden, "Cross-origin request refused")
		return
	}
	http.SetCookie(w, s.sesiones.CookieBorrada())

	siguiente := "/"
	if s.cfg.OIDC != nil {
		ctx, cancel := context.WithTimeout(r.Context(), s.cfg.OIDC.Timeout)
		defer cancel()
		// Si el proveedor no anuncia el endpoint, o preguntarle falla, se sale
		// igualmente de la aplicación: cerrar la sesión propia ya está hecho y
		// no puede quedar a medias por un fallo de red.
		if e, err := s.disc.Endpoints(ctx, s.cfg.OIDC); err == nil && e.EndSession != "" {
			siguiente = e.EndSession
		}
	}
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true, "next": siguiente})
}

// POST /api/auth/backchannel-logout — el proveedor avisa de que una sesión suya
// ha terminado.
//
// La llama el PROVEEDOR, servidor a servidor, así que aquí no hay cookies, ni
// CSRF, ni origen que comprobar: lo único que autentica esta petición es la
// firma del logout_token.
//
// Como la sesión de aquí es una cookie firmada y no vive en el servidor, no hay
// nada que borrar: se anota a esa persona en la lista de revocación, y desde ese
// instante sus cookies dejan de valer.
//
// Los códigos son los que espera la especificación: 200 si se ha atendido, 400
// si el token no vale. Nada de 401/403, que harían que el proveedor reintentara
// eternamente algo que nunca va a mejorar.
func (s *Server) backchannel(w http.ResponseWriter, r *http.Request) {
	if s.cfg.OIDC == nil {
		errorJSON(w, http.StatusNotFound, "not_configured")
		return
	}
	if !strings.Contains(r.Header.Get("content-type"), "application/x-www-form-urlencoded") {
		errorJSON(w, http.StatusBadRequest, "unsupported_media_type")
		return
	}
	// Un Logout Token son unos cientos de bytes; 16 KiB es holgado de sobra.
	// Este endpoint es público y no autenticado —lo tiene que ser—, así que sin
	// un tope un cuerpo enorme se acumula en memoria: un reinicio provocable
	// desde fuera es una palanca que no hay por qué regalar. Se mira la
	// cabecera Y se cuenta lo que llega, porque quien llama puede mentir.
	const limite = 16 * 1024
	if r.ContentLength > limite {
		errorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large")
		return
	}
	datos, err := io.ReadAll(io.LimitReader(r.Body, limite+1))
	if err != nil || len(datos) > limite {
		errorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large")
		return
	}
	valores, err := url.ParseQuery(string(datos))
	if err != nil || valores.Get("logout_token") == "" {
		errorJSON(w, http.StatusBadRequest, "missing logout_token")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.OIDC.Timeout)
	defer cancel()
	endpoints, err := s.disc.Endpoints(ctx, s.cfg.OIDC)
	if err != nil {
		// No se ha podido hablar con el proveedor para comprobar la firma: eso
		// es un fallo nuestro y sí merece que lo reintente.
		errorJSON(w, http.StatusServiceUnavailable, "verification unavailable")
		return
	}
	aviso, err := s.verif.Verificar(ctx, valores.Get("logout_token"), s.cfg.OIDC, endpoints)
	switch {
	case err == nil:
	case errorEs(err, auth.ErrNoVerificable):
		errorJSON(w, http.StatusServiceUnavailable, "verification unavailable")
		return
	case errorEs(err, auth.ErrSoloSid):
		// Se dice que no se soporta en vez de responder 200 sin haber revocado
		// nada: un 200 le dice al proveedor que la sesión está cerrada aquí, y
		// no lo está.
		errorJSON(w, http.StatusBadRequest, "sid-only logout_token not supported")
		return
	default:
		errorJSON(w, http.StatusBadRequest, "invalid logout_token")
		return
	}

	// La cookie de aquí nombra al usuario por su id interno, no por el `sub` del
	// proveedor, así que la lista se lleva por ese id: es lo que se puede
	// comprobar al leer una cookie sin ir a buscar nada.
	if persona := s.cuentas.PorSub(aviso.Sub); persona != nil {
		if err := s.rev.Revocar(persona.ID); err != nil {
			// Si no se puede escribir la lista, la revocación NO ha ocurrido.
			// Decirlo, para que el proveedor lo reintente: perderla en silencio
			// sería dejar dentro a quien se acaba de echar.
			errorJSON(w, http.StatusServiceUnavailable, "could not record revocation")
			return
		}
	}
	// El anti-replay se anota SÓLO después de que la revocación haya surtido
	// efecto: apuntarlo antes dejaría un aviso legítimo sin aplicar si la
	// escritura falla y el proveedor reintenta.
	s.verif.Anotar(aviso.JTI)
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
}
