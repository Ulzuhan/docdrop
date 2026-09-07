package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"io"
	"net/http"

	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Ulzuhan/docdrop/internal/auth"
	"github.com/Ulzuhan/docdrop/internal/store"
	"github.com/Ulzuhan/docdrop/internal/uploads"
)

// POST /api/upload — el cuerpo ES el fichero (no es multipart).
//
// Los metadatos viajan en cabeceras:
//
//	x-filename            nombre original, codificado como componente de URL
//	x-ttl-hours           horas hasta la autodestrucción (1..720)
//	x-max-downloads       0 = sin límite
//	x-docdrop-encrypted   "1" si el cuerpo es un bulto cifrado
func (s *Server) subir(w http.ResponseWriter, r *http.Request) {
	if !s.mutacionDelMismoOrigen(r) {
		errorJSON(w, http.StatusForbidden, "Cross-origin request refused")
		return
	}
	// Subir necesita sesión o un enlace de invitado vivo: expuesto a internet,
	// un endpoint de subida abierto es alojamiento anónimo gratis y una forma
	// trivial de llenar el disco.
	if !s.exigirAccesoSubida(w, r) {
		return
	}
	invitado := s.invitadoDe(r)
	var cuenta *auth.Usuario
	if invitado == nil {
		cuenta = s.usuarioActual(r)
	}

	if res := s.limites.Permitir("upload:"+IPCliente(r), 30, time.Hour); !res.Permitido {
		demasiadas(w, res)
		return
	}
	if r.ContentLength == 0 && r.Header.Get("Transfer-Encoding") == "" {
		errorJSON(w, http.StatusBadRequest, "Empty request body")
		return
	}

	bruto := r.Header.Get("x-filename")
	if bruto == "" {
		errorJSON(w, http.StatusBadRequest, "Missing x-filename header")
		return
	}
	descodificado, ok := decodificarComponente(bruto)
	if !ok {
		errorJSON(w, http.StatusBadRequest, "Malformed x-filename header")
		return
	}
	nombre := store.NombreSeguro(descodificado)

	// Un invitado tiene un techo más bajo, aplicado en el servidor.
	horas := store.ClampTTL(cabecera(r, "x-ttl-hours"))
	if invitado != nil {
		horas = min(horas, auth.MaxTTLFicheroInvitadoHoras)
	}
	maxBajadas := store.ClampBajadas(cabecera(r, "x-max-downloads"))

	// Rechazo temprano cuando el cliente ya declara un tamaño excesivo, para no
	// escribir gigabytes en disco antes de darnos cuenta.
	declarado := int64(0)
	if r.ContentLength > 0 {
		declarado = r.ContentLength
	}
	if declarado > s.almacen.MaxFichero() {
		errorJSON(w, http.StatusRequestEntityTooLarge, "File too large. Max 10GB.")
		return
	}

	// Se aparta el sitio bajo el candado y se transmite FUERA de él. Se aparta
	// lo que el cliente declara; si no declara nada, lo que quepa, que es la
	// opción conservadora.
	reservado := s.almacen.Reservar(func(disponible int64) int64 {
		if disponible <= 0 {
			return 0
		}
		if declarado > disponible {
			return 0
		}
		tope := min(s.almacen.MaxFichero(), disponible)
		if declarado > 0 {
			return min(declarado, tope)
		}
		return tope
	})
	if reservado == 0 {
		errorJSON(w, http.StatusInsufficientStorage, "Not enough storage left for this file.")
		return
	}
	// Pase lo que pase. Si no se suelta, el hueco queda apartado para siempre y
	// la instancia se va quedando sin sitio sola.
	defer s.almacen.Soltar(reservado)

	id, err := store.NuevoID()
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "Upload failed")
		return
	}
	if err := s.almacen.CrearEntrada(id); err != nil {
		errorJSON(w, http.StatusInternalServerError, "Upload failed")
		return
	}
	limpiar := func() { _ = s.almacen.BorrarEntrada(id) }

	ruta, _ := s.almacen.RutaBlob(id)
	f, err := os.OpenFile(ruta, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		limpiar()
		errorJSON(w, http.StatusInternalServerError, "Upload failed")
		return
	}
	// El corte de verdad se aplica a lo que LLEGA, no a lo declarado.
	escritos, cerr := copiar(r.Context(), f, r.Body, reservado)
	if err := f.Close(); err != nil && cerr == nil {
		cerr = err
	}
	if cerr != nil {
		// Sin esto, una subida interrumpida dejaba un directorio a medias para
		// siempre.
		limpiar()
		if errorEs(cerr, errDemasiadoGrande) {
			errorJSON(w, http.StatusRequestEntityTooLarge, "File too large. Max 10GB.")
			return
		}
		if r.Context().Err() != nil {
			// El cliente se fue, o el servicio está parando. No hay a quién
			// contestar; lo que importa es que no quede basura.
			return
		}
		avisar("[docdrop] subida fallida: %v", cerr)
		errorJSON(w, http.StatusInternalServerError, "Upload failed")
		return
	}
	if escritos == 0 {
		limpiar()
		errorJSON(w, http.StatusBadRequest, "Empty file")
		return
	}

	ahora := s.almacen.Ahora()
	meta := &store.Meta{
		ID:           id,
		OriginalName: nombre,
		Size:         escritos, // el tamaño sale del disco, no de lo que dijo el cliente
		MimeType:     primeroNoVacio(r.Header.Get("content-type"), "application/octet-stream"),
		UploadedAt:   ahora.UnixMilli(),
		ExpiresAt:    ahora.Add(time.Duration(horas) * time.Hour).UnixMilli(),
		MaxDownloads: maxBajadas,
		// El nombre de la cuenta, o la etiqueta del enlace. Nunca lo que diga
		// el cliente.
		UploadedBy: etiquetaDe(cuenta, invitado),
		// La credencial, no la etiqueta: lo subido por cuenta es de esa cuenta,
		// y lo subido por un enlace de invitado, de quien emitió el enlace.
		Owner: s.duenoDe(cuenta, invitado),
		// Autodeclarado: al servidor le da igual qué bytes custodia. La marca
		// sólo cambia qué camino toma la página de descarga, y mentir aquí sólo
		// le rompe la descarga a quien mintió.
		Encrypted: r.Header.Get("x-docdrop-encrypted") == "1",
	}
	if err := s.almacen.EscribirMeta(meta); err != nil {
		limpiar()
		errorJSON(w, http.StatusInternalServerError, "Upload failed")
		return
	}
	if invitado != nil {
		s.invitados.Anotar(invitado.Token)
	}
	escribirJSON(w, http.StatusOK, map[string]any{
		"id":           meta.ID,
		"originalName": meta.OriginalName,
		"size":         meta.Size,
		"expiresAt":    meta.ExpiresAt,
		"maxDownloads": meta.MaxDownloads,
		"downloadUrl":  "/d/" + meta.ID,
	})
}

// POST /api/upload/init — abre una subida troceada.
//
// El límite por IP se aplica aquí y no por trozo: una subida de 7 GB son
// cientos de peticiones de trozo, y contarlas todas agotaría el cupo al vuelo.
func (s *Server) iniciarTroceada(w http.ResponseWriter, r *http.Request) {
	if !s.exigirAccesoSubida(w, r) {
		return
	}
	invitado := s.invitadoDe(r)

	if res := s.limites.Permitir("upload-init:"+IPCliente(r), 30, time.Hour); !res.Permitido {
		demasiadas(w, res)
		return
	}
	cuerpo := cuerpoJSON(r)
	if cuerpo == nil {
		errorJSON(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}
	nombre, _ := cuerpo["filename"].(string)
	if nombre == "" {
		errorJSON(w, http.StatusBadRequest, "filename is required")
		return
	}
	tamano, entero := enteroSeguro(cuerpo["size"])
	if !entero || tamano <= 0 {
		errorJSON(w, http.StatusBadRequest, "size must be a positive integer")
		return
	}
	if tamano > s.almacen.MaxFichero() {
		errorJSON(w, http.StatusRequestEntityTooLarge, "File too large")
		return
	}

	// Un invitado tiene un techo más bajo, aplicado AQUÍ y no confiado a la
	// página: la API se alcanza con el token pelado.
	var ttl any = store.Campo(cuerpo, "ttlHours")
	if invitado != nil {
		ttl = min(store.ClampTTL(ttl), auth.MaxTTLFicheroInvitadoHoras)
	}
	var cuenta *auth.Usuario
	if invitado == nil {
		cuenta = s.usuarioActual(r)
	}

	var sesion *uploads.Sesion
	cupo, err := s.almacen.ConCuota(tamano, func() error {
		var err error
		sesion, err = s.subidas.Crear(uploads.Entrada{
			Nombre:     nombre,
			Tamano:     tamano,
			MimeType:   cadena(cuerpo["mimeType"]),
			TTLHoras:   ttl,
			MaxBajadas: store.Campo(cuerpo, "maxDownloads"),
			// Nada de lo que escriba el cliente llega a este campo: un nombre
			// libre junto a un inicio de sesión obligatorio sólo servía para
			// hacerse pasar por otro en el listado.
			SubidoPor: etiquetaDe(cuenta, invitado),
			Owner:     s.credencialDeSesion(cuenta, invitado),
			Cifrado:   cuerpo["encrypted"] == true,
		})
		return err
	})
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "Upload failed")
		return
	}
	if !cupo {
		errorJSON(w, http.StatusInsufficientStorage, "Not enough storage left for this file.")
		return
	}
	if invitado != nil {
		s.invitados.Anotar(invitado.Token)
	}
	escribirJSON(w, http.StatusOK, map[string]any{
		"uploadId":   sesion.ID,
		"chunkSize":  sesion.ChunkSize,
		"totalParts": sesion.TotalParts,
		"received":   []int{},
	})
}

// sesionDeSubida resuelve la sesión y comprueba que quien llama es su dueño.
//
// Tener acceso y ser el dueño de ESTA subida son cosas distintas. Sin esto, con
// dos enlaces de invitado el segundo escribía el trozo 0 del fichero que estaba
// subiendo el primero. Mismo 404 que si no existiera: quien no es de aquí no
// tiene por qué enterarse de que hay algo.
func (s *Server) sesionDeSubida(w http.ResponseWriter, r *http.Request, comprobarCaducidad bool) *uploads.Sesion {
	id := r.PathValue("uploadId")
	sesion := s.subidas.Leer(id)
	if sesion == nil {
		errorJSON(w, http.StatusNotFound, "Upload session not found")
		return nil
	}
	if !esDueno(sesion.Owner, s.credencialDe(r)) {
		errorJSON(w, http.StatusNotFound, "Upload session not found")
		return nil
	}
	if comprobarCaducidad && sesion.SessionExpiresAt < s.almacen.Ahora().UnixMilli() {
		errorJSON(w, http.StatusGone, "Upload session expired")
		return nil
	}
	return sesion
}

// GET /api/upload/{uploadId} — estado de una subida en vuelo.
//
// Esto es lo que hace posible reanudar: el cliente pregunta qué trozos llegaron
// y manda sólo los que faltan, en vez de empezar de cero tras un corte de red.
func (s *Server) estadoTroceada(w http.ResponseWriter, r *http.Request) {
	if !s.exigirAccesoSubida(w, r) {
		return
	}
	sesion := s.sesionDeSubida(w, r, true)
	if sesion == nil {
		return
	}
	recibidas := s.subidas.PartesRecibidas(sesion.ID)
	if recibidas == nil {
		recibidas = []int{}
	}
	escribirJSON(w, http.StatusOK, map[string]any{
		"uploadId":     sesion.ID,
		"originalName": sesion.OriginalName,
		"size":         sesion.Size,
		"chunkSize":    sesion.ChunkSize,
		"totalParts":   sesion.TotalParts,
		"received":     recibidas,
		"complete":     len(recibidas) == sesion.TotalParts,
	})
}

// DELETE /api/upload/{uploadId} — cancela y borra lo subido hasta ahora.
func (s *Server) cancelarTroceada(w http.ResponseWriter, r *http.Request) {
	if !s.exigirAccesoSubida(w, r) {
		return
	}
	sesion := s.sesionDeSubida(w, r, false)
	if sesion == nil {
		return
	}
	if err := s.subidas.Abortar(sesion.ID); err != nil {
		errorJSON(w, http.StatusInternalServerError, "Could not cancel the upload")
		return
	}
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true, "id": sesion.ID})
}

// PUT /api/upload/{uploadId}/part/{index} — recibe un trozo.
//
// El cuerpo es el trozo en crudo y se escribe directamente en su posición
// dentro del fichero final, así que no hay nada que ensamblar después.
//
// Es idempotente: reenviar un trozo ya recibido contesta 200 sin volver a
// escribirlo, que es lo que hace seguro reintentar cuando la red falla.
func (s *Server) subirTrozo(w http.ResponseWriter, r *http.Request) {
	if !s.exigirAccesoSubida(w, r) {
		return
	}
	// Cupo generoso: una subida grande son cientos de trozos legítimos.
	if res := s.limites.Permitir("upload-part:"+IPCliente(r), 5000, time.Hour); !res.Permitido {
		demasiadas(w, res)
		return
	}
	sesion := s.sesionDeSubida(w, r, true)
	if sesion == nil {
		return
	}
	indice, err := strconv.Atoi(r.PathValue("index"))
	if err != nil || indice < 0 || indice >= sesion.TotalParts {
		errorJSON(w, http.StatusBadRequest, "Invalid part index")
		return
	}
	if s.subidas.ParteRecibida(sesion.ID, indice) {
		escribirJSON(w, http.StatusOK, map[string]any{"ok": true, "index": indice, "alreadyReceived": true})
		return
	}
	if r.ContentLength == 0 && r.Header.Get("Transfer-Encoding") == "" {
		errorJSON(w, http.StatusBadRequest, "Empty body")
		return
	}

	esperado := uploads.TamanoParte(sesion, indice)
	inicio, _ := uploads.RangoParte(sesion, indice)

	// El cliente puede mandar el SHA-256 del trozo. Con reintentos automáticos y
	// reanudación de por medio, un trozo corrompido pasaría desapercibido: el
	// tamaño cuadraría y se aceptaría. La cabecera es opcional porque
	// crypto.subtle sólo existe en contextos seguros (HTTPS o localhost).
	declarado := strings.ToLower(strings.TrimSpace(r.Header.Get("x-chunk-sha256")))
	var resumen hash.Hash
	origen := io.Reader(r.Body)
	if declarado != "" {
		resumen = sha256.New()
		origen = io.TeeReader(r.Body, resumen)
	}

	ruta, _ := s.almacen.RutaBlob(sesion.ID)
	// Se abre SIN truncar y se escribe en el desplazamiento del trozo.
	f, err := os.OpenFile(ruta, os.O_WRONLY, 0o640)
	if err != nil {
		errorJSON(w, http.StatusNotFound, "Upload session not found")
		return
	}
	escritos, cerr := copiar(r.Context(), &escritorEn{f: f, pos: inicio}, origen, esperado)
	if err := f.Close(); err != nil && cerr == nil {
		cerr = err
	}
	if cerr != nil {
		if errorEs(cerr, errDemasiadoGrande) {
			errorJSON(w, http.StatusRequestEntityTooLarge, "Part larger than expected")
			return
		}
		if r.Context().Err() != nil {
			return // cliente ido o servicio parando: el trozo NO se marca
		}
		avisar("[docdrop] trozo fallido: %v", cerr)
		errorJSON(w, http.StatusInternalServerError, "Part upload failed")
		return
	}

	// Un trozo corto significa que la conexión se cortó a mitad: no se marca
	// como recibido, así que el cliente lo reintenta y reescribe el mismo rango.
	if escritos != esperado {
		escribirJSON(w, http.StatusBadRequest, map[string]any{
			"error": "Incomplete part", "expected": esperado, "received": escritos,
		})
		return
	}
	// Integridad: si no cuadra NO se marca como recibido, así que el cliente lo
	// reenvía y reescribe el mismo rango.
	if resumen != nil {
		real := hex.EncodeToString(resumen.Sum(nil))
		if real != declarado {
			escribirJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error": "Checksum mismatch", "expected": declarado, "actual": real,
			})
			return
		}
	}
	if err := s.subidas.MarcarParte(sesion.ID, indice); err != nil {
		errorJSON(w, http.StatusInternalServerError, "Part upload failed")
		return
	}
	escribirJSON(w, http.StatusOK, map[string]any{"ok": true, "index": indice, "size": escritos})
}

// POST /api/upload/{uploadId}/complete — cierra la subida.
//
// Sólo termina bien cuando están todos los trozos; si falta alguno contesta 409
// con la lista, para que el cliente los reenvíe en vez de dar la subida por
// perdida.
func (s *Server) completarTroceada(w http.ResponseWriter, r *http.Request) {
	// Cerrar una subida es un POST sin cuerpo, así que la exigencia de
	// `application/json` que cubre a las demás no llega aquí: una página hermana
	// puede lanzarlo y el navegador manda la cookie, porque compartir dominio
	// los hace el mismo sitio. La comprobación de dueño no ayuda —la credencial
	// que viaja es la de la víctima—. Comprobado: devolvía 200.
	if !s.mutacionDelMismoOrigen(r) {
		errorJSON(w, http.StatusForbidden, "Cross-origin request refused")
		return
	}
	if !s.exigirAccesoSubida(w, r) {
		return
	}
	sesion := s.sesionDeSubida(w, r, true)
	if sesion == nil {
		return
	}
	meta, faltan, err := s.subidas.Completar(sesion)
	if errorEs(err, uploads.ErrFaltanPartes) {
		escribirJSON(w, http.StatusConflict, map[string]any{"error": "Missing parts", "missing": faltan})
		return
	}
	if err != nil {
		avisar("[docdrop] no se pudo cerrar la subida: %v", err)
		errorJSON(w, http.StatusInternalServerError, "Could not complete the upload")
		return
	}
	escribirJSON(w, http.StatusOK, map[string]any{
		"id":           meta.ID,
		"originalName": meta.OriginalName,
		"size":         meta.Size,
		"expiresAt":    meta.ExpiresAt,
		"maxDownloads": meta.MaxDownloads,
		"downloadUrl":  "/d/" + meta.ID,
	})
}

// ─── Ayudas ─────────────────────────────────────────────────────────

// cabecera devuelve el valor de una cabecera o el centinela de «ausente». La
// diferencia importa: `Number(null)` es 0 y `Number(undefined)` es NaN, así que
// una cabecera ausente y un campo ausente de un JSON dan TTL distintos. Es el
// comportamiento de la versión de Node.
func cabecera(r *http.Request, nombre string) any {
	if v, hay := r.Header[http.CanonicalHeaderKey(nombre)]; hay && len(v) > 0 {
		return v[0]
	}
	return nil
}

func cadena(v any) string {
	s, _ := v.(string)
	return s
}

func primeroNoVacio(v, porDefecto string) string {
	if v == "" {
		return porDefecto
	}
	return v
}

// enteroSeguro es `Number.isSafeInteger` sobre lo que llegue de un JSON.
func enteroSeguro(v any) (int64, bool) {
	n, ok := v.(float64)
	if !ok {
		return 0, false
	}
	if n != float64(int64(n)) || n > 9007199254740991 || n < -9007199254740991 {
		return 0, false
	}
	return int64(n), true
}

// etiquetaDe es el nombre con el que se marca lo subido: el de la cuenta, o el
// del enlace de invitado.
func etiquetaDe(cuenta *auth.Usuario, invitado *auth.Enlace) string {
	if cuenta != nil {
		return cuenta.NombreVisible()
	}
	if invitado != nil {
		return invitado.Label
	}
	return ""
}

// duenoDe es la credencial que se guarda en la ficha de un fichero terminado.
func (s *Server) duenoDe(cuenta *auth.Usuario, invitado *auth.Enlace) string {
	if cuenta != nil {
		return "user:" + cuenta.ID
	}
	if invitado != nil {
		return s.invitados.DuenoDe(invitado.Token)
	}
	return ""
}

// credencialDeSesion es el dueño que se guarda en una subida troceada, sin
// resolver todavía: `guest:<token>` se convierte en el emisor al completar.
//
// Si no hay ni invitado ni cuenta —instancia sin identidad configurada— queda
// sin dueño, y entonces se comporta como antes: no hay a quién distinguir.
func (s *Server) credencialDeSesion(cuenta *auth.Usuario, invitado *auth.Enlace) string {
	if invitado != nil {
		return "guest:" + invitado.Token
	}
	if cuenta != nil {
		return "user:" + cuenta.ID
	}
	return ""
}

// decodificarComponente es `decodeURIComponent` sobre una cabecera HTTP, y las
// dos mitades de esa frase importan.
//
// Una cabecera son BYTES. Node las entrega interpretadas como latin-1 —cada
// byte, un carácter— y Go entrega los bytes tal cual, así que un nombre con «ñ»
// mandado sin escapar llega aquí como una cadena que no es UTF-8 válido. El
// cliente de verdad escapa el nombre, pero las suites lo mandan crudo y la
// versión de Node lo acepta: rechazarlo sería una diferencia de comportamiento
// inventada por el port.
//
// Así que primero se lee como latin-1 y después se deshacen los `%XX`, cuyos
// bytes SÍ tienen que formar UTF-8 válido (es lo que hace lanzar a
// `decodeURIComponent`, y de ahí sale el 400).
func decodificarComponente(bruto string) (string, bool) {
	var salida []rune
	var pendientes []byte
	volcar := func() bool {
		if len(pendientes) == 0 {
			return true
		}
		if !utf8.Valid(pendientes) {
			return false
		}
		salida = append(salida, []rune(string(pendientes))...)
		pendientes = pendientes[:0]
		return true
	}
	for i := 0; i < len(bruto); i++ {
		c := bruto[i]
		if c == '%' {
			if i+2 >= len(bruto) {
				return "", false
			}
			v, err := strconv.ParseUint(bruto[i+1:i+3], 16, 8)
			if err != nil {
				return "", false
			}
			pendientes = append(pendientes, byte(v))
			i += 2
			continue
		}
		if !volcar() {
			return "", false
		}
		// latin-1: el byte ES el punto de código.
		salida = append(salida, rune(c))
	}
	if !volcar() {
		return "", false
	}
	return string(salida), true
}
