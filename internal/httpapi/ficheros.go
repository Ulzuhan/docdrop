package httpapi

import (
	"net/http"
	"sort"
	"time"

	"github.com/Ulzuhan/docdrop/internal/store"
)

// GET /api/files — TUS ficheros activos, los más nuevos primero.
//
// «Tus», y esa palabra es el arreglo. Esto listaba todos los ficheros de la
// instancia a cualquiera con sesión: la herramienta nació como carpeta de un
// solo operador —la cuenta era la puerta, no el inquilino— y al llegar las
// cuentas múltiples nadie separó la habitación.
//
// Los ficheros sin dueño (anteriores al campo) no se enseñan a nadie: su enlace
// directo sigue siendo válido y la caducidad los retira sola.
//
// Lee siempre del disco, la única fuente de verdad.
func (s *Server) listarFicheros(w http.ResponseWriter, r *http.Request) {
	// Necesita sesión: este listado enumera TODOS los enlaces activos de quien
	// pregunta, así que dejarlo público sería publicar sus ficheros.
	if !s.exigirSesion(w, r) {
		return
	}
	yo := "user:" + s.usuarioActual(r).ID
	ahora := s.almacen.Ahora()
	mios := []store.Meta{}
	for _, m := range s.almacen.ListarMeta() {
		if m.Disponible(ahora) && m.Owner == yo {
			mios = append(mios, m)
		}
	}
	sort.SliceStable(mios, func(i, j int) bool { return mios[i].UploadedAt > mios[j].UploadedAt })

	escribirJSON(w, http.StatusOK, map[string]any{
		"files": mios,
		"storage": map[string]any{
			"usedBytes":  s.almacen.Usado(),
			"totalBytes": s.almacen.MaxTotal(),
		},
		// Se conserva para que el panel siga ofreciendo su botón de salir.
		"authEnabled": true,
	})
}

// DELETE /api/files/{id} — borra un fichero antes de que caduque.
func (s *Server) borrarFichero(w http.ResponseWriter, r *http.Request) {
	if !s.exigirSesion(w, r) {
		return
	}
	id := r.PathValue("id")
	if !store.IDValido(id) {
		errorJSON(w, http.StatusNotFound, "File not found")
		return
	}
	m := s.almacen.LeerMeta(id)
	if m == nil {
		errorJSON(w, http.StatusNotFound, "File not found")
		return
	}
	// Sólo su dueño borra, y un fichero ajeno contesta lo mismo que uno que no
	// existe: este endpoint no debe servir para comprobar qué ids hay. Antes
	// bastaba la sesión, así que cualquier cuenta podía borrar lo de todas. Un
	// fichero sin dueño no lo borra nadie desde aquí: caduca solo.
	if m.Owner == "" || m.Owner != "user:"+s.usuarioActual(r).ID {
		errorJSON(w, http.StatusNotFound, "File not found")
		return
	}
	if err := s.almacen.BorrarEntrada(id); err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not delete the file")
		return
	}
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id})
}

// POST /api/cleanup — borra lo caducado, lo agotado y los directorios huérfanos
// que dejan las subidas interrumpidas.
//
// Necesita sesión: abierto, cualquiera podría forzar purgas. El servidor barre
// solo cada hora; esto es sólo para forzarlo a mano.
func (s *Server) limpiar(w http.ResponseWriter, r *http.Request) {
	if !s.mutacionDelMismoOrigen(r) {
		errorJSON(w, http.StatusForbidden, "Cross-origin request refused")
		return
	}
	if !s.exigirSesion(w, r) {
		return
	}
	abandonadas, borrados, invitados := s.Barrer()
	escribirJSON(w, http.StatusOK, map[string]any{
		"deleted":           borrados,
		"abandonedUploads":  abandonadas,
		"expiredGuestLinks": invitados,
		"count":             len(borrados) + len(abandonadas),
		"timestamp":         s.almacen.Ahora().UnixMilli(),
	})
}

// Barrer es la limpieza completa: primero las subidas troceadas abandonadas
// —así liberan el espacio que tenían apartado y dejan de estar protegidas del
// barrido general— y después lo caducado y los enlaces vencidos.
func (s *Server) Barrer() (abandonadas, borrados []string, invitados int) {
	abandonadas = s.subidas.LimpiarSesiones()
	if abandonadas == nil {
		abandonadas = []string{}
	}
	borrados = s.almacen.Limpiar()
	if borrados == nil {
		borrados = []string{}
	}
	invitados = s.invitados.Limpiar()
	return abandonadas, borrados, invitados
}

// ─── Enlaces de invitado ────────────────────────────────────────────

// GET /api/guest-links — LOS TUYOS, no los de todos.
//
// La sesión bastaba y cualquier cuenta veía —y podía revocar— los enlaces de
// las demás: mismo fallo de fondo que el listado de ficheros. Los emitidos
// antes de que los enlaces llevaran emisor no se enseñan a nadie y caducan
// solos.
func (s *Server) listarInvitados(w http.ResponseWriter, r *http.Request) {
	if !s.exigirSesion(w, r) {
		return
	}
	yo := s.usuarioActual(r).ID
	enlaces := []map[string]any{}
	for _, e := range s.invitados.Listar() {
		if e.CreatedBy == "" || e.CreatedBy != yo {
			continue
		}
		enlaces = append(enlaces, map[string]any{
			"token":       e.Token,
			"label":       e.Label,
			"createdAt":   e.CreatedAt,
			"expiresAt":   e.ExpiresAt,
			"uploadCount": e.UploadCount,
			"createdBy":   e.CreatedBy,
		})
	}
	escribirJSON(w, http.StatusOK, map[string]any{"links": enlaces})
}

// POST /api/guest-links — acuña un enlace de subida para invitados.
func (s *Server) crearInvitado(w http.ResponseWriter, r *http.Request) {
	if !s.exigirSesion(w, r) {
		return
	}
	// Tope modesto: los enlaces los acuña una persona, no un script. Sobre todo
	// es protección contra un cliente desbocado llenando el directorio.
	if res := s.limites.Permitir("guest-links:"+IPCliente(r), 30, time.Hour); !res.Permitido {
		demasiadas(w, res)
		return
	}
	cuerpo := cuerpoJSON(r)
	if cuerpo == nil {
		errorJSON(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}
	// Con su emisor: es lo que hace que lo subido por el enlace aparezca en el
	// panel de quien lo repartió, y que nadie más pueda listarlo ni revocarlo.
	enlace, err := s.invitados.Crear(store.Campo(cuerpo, "ttlHours"), cuerpo["label"], s.usuarioActual(r).ID)
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not create the guest link")
		return
	}
	escribirJSON(w, http.StatusCreated, map[string]any{"link": map[string]any{
		"token":       enlace.Token,
		"label":       enlace.Label,
		"createdAt":   enlace.CreatedAt,
		"expiresAt":   enlace.ExpiresAt,
		"uploadCount": enlace.UploadCount,
		"createdBy":   enlace.CreatedBy,
	}})
}

// DELETE /api/guest-links/{token} — revoca un enlace al instante.
func (s *Server) revocarInvitado(w http.ResponseWriter, r *http.Request) {
	if !s.exigirSesion(w, r) {
		return
	}
	token := r.PathValue("token")
	// Sólo su emisor lo revoca, y un enlace ajeno contesta lo mismo que uno
	// inexistente: la respuesta no debe servir para sondear tokens de otros.
	enlace := s.invitados.Leer(token)
	if enlace == nil || enlace.CreatedBy == "" || enlace.CreatedBy != s.usuarioActual(r).ID {
		errorJSON(w, http.StatusNotFound, "Guest link not found")
		return
	}
	if !s.invitados.Revocar(token) {
		errorJSON(w, http.StatusNotFound, "Guest link not found")
		return
	}
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /api/guest/{token} — ¿sirve este enlace de invitado?
//
// Público a propósito: la página del invitado pregunta antes de enseñar el
// subidor, y el token de la URL es la credencial que se comprueba. Sólo revela
// lo que quien tiene el enlace tiene derecho a saber: que funciona, para quién
// se hizo y hasta cuándo. Nunca enumera nada.
func (s *Server) comprobarInvitado(w http.ResponseWriter, r *http.Request) {
	// Misma forma que el limitador del login: este endpoint es el único oráculo
	// para adivinar tokens, así que sondearlo se pone caro enseguida. Con 128
	// bits adivinar es inútil de todos modos; el límite sólo baja el ruido.
	if res := s.limites.Permitir("guest-check:"+IPCliente(r), 30, 15*time.Minute); !res.Permitido {
		demasiadas(w, res)
		return
	}
	enlace := s.invitados.Valido(r.PathValue("token"))
	if enlace == nil {
		errorJSON(w, http.StatusNotFound, "This guest link is no longer valid")
		return
	}
	var etiqueta any
	if enlace.Label != "" {
		etiqueta = enlace.Label
	}
	escribirJSON(w, http.StatusOK, map[string]any{"label": etiqueta, "expiresAt": enlace.ExpiresAt})
}
