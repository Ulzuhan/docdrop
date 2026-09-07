package httpapi

import (
	"encoding/base64"
	"encoding/binary"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Ulzuhan/docdrop/internal/store"
)

var motivoATexto = map[error]string{
	store.ErrCaducado: "File expired",
	store.ErrAgotado:  "Max downloads reached",
}

// responderNoDisponible traduce un error del almacén a la respuesta pública.
// Un fichero que no existe y uno cuyo id está mal contestan lo mismo: este
// endpoint no debe servir para averiguar qué ids hay.
func responderNoDisponible(w http.ResponseWriter, err error) {
	if errorEs(err, store.ErrNoEncontrado) {
		errorJSON(w, http.StatusNotFound, "File not found")
		return
	}
	errorJSON(w, http.StatusGone, motivoATexto[err])
}

var reRango = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

type rango struct{ inicio, fin int64 }

// rangoDeBytes interpreta un rango ÚNICO antes de tomar plaza de descarga.
// Devuelve false si la cabecera no vale: un rango inválido no puede consumir
// plaza ni establecer una continuación gratis.
func rangoDeBytes(valor string, tamano int64) (rango, bool) {
	m := reRango.FindStringSubmatch(strings.TrimSpace(valor))
	if m == nil || (m[1] == "" && m[2] == "") || tamano == 0 {
		return rango{}, false
	}
	primero, err1 := numeroDeGrupo(m[1])
	ultimo, err2 := numeroDeGrupo(m[2])
	if !err1 || !err2 {
		return rango{}, false
	}
	// `bytes=-0` no pide nada.
	if m[1] == "" && ultimo == 0 {
		return rango{}, false
	}
	var inicio, fin int64
	if m[1] != "" {
		inicio = primero
	} else {
		inicio = max(0, tamano-ultimo)
	}
	if m[1] != "" && m[2] != "" {
		fin = min(ultimo, tamano-1)
	} else {
		fin = tamano - 1
	}
	if inicio <= fin && inicio < tamano {
		return rango{inicio, fin}, true
	}
	return rango{}, false
}

// numeroDeGrupo es `Number("")` = 0 más `Number.isSafeInteger`.
func numeroDeGrupo(s string) (int64, bool) {
	if s == "" {
		return 0, true
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n > 9007199254740991 {
		return 0, false
	}
	return n, true
}

// GET /api/download/{id} — descarga pública por capacidad.
//
// Sólo las respuestas completas y contabilizadas habilitan continuaciones.
func (s *Server) descargar(w http.ResponseWriter, r *http.Request) {
	cliente := IPCliente(r)
	if res := s.limites.Permitir("download:"+cliente, 240, time.Minute); !res.Permitido {
		demasiadas(w, res)
		return
	}
	id := r.PathValue("id")
	if !store.IDValido(id) {
		errorJSON(w, http.StatusNotFound, "File not found")
		return
	}

	// Se comprueba disponibilidad SIN reservar nada: un rango malo o un blob que
	// falta no deben consumir plaza ni establecer una continuación gratis.
	disponible, err := s.almacen.Reclamar(id, false)
	if err != nil {
		responderNoDisponible(w, err)
		return
	}
	ruta, _ := s.almacen.RutaBlob(id)
	info, serr := os.Stat(ruta)
	if serr != nil {
		errorJSON(w, http.StatusNotFound, "File data not found")
		return
	}
	tamano := info.Size()

	cabeceraRango := r.Header.Get("Range")
	var parcial *rango
	if cabeceraRango != "" {
		p, ok := rangoDeBytes(cabeceraRango, tamano)
		if !ok {
			w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(tamano, 10))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		parcial = &p
	}

	// Las vistas previas conservan su semántica, sólo para tipos seguros.
	vistaPrevia := r.URL.Query().Get("inline") == "1" && store.SeguroEnLinea(disponible.Meta.MimeType)
	reanudando := cabeceraRango != "" && s.almacen.TransferenciaReanudada(id, cliente)

	// Se vuelve a comprobar bajo el candado del fichero: la disponibilidad puede
	// cambiar durante el stat y la validación.
	reclamo, err := s.almacen.Reclamar(id, !vistaPrevia && !reanudando)
	if err != nil {
		responderNoDisponible(w, err)
		return
	}

	f, ferr := os.Open(ruta)
	if ferr != nil {
		_ = reclamo.Hecho(false)
		errorJSON(w, http.StatusNotFound, "File data not found")
		return
	}
	defer f.Close()

	longitud := tamano
	if parcial != nil {
		longitud = parcial.fin - parcial.inicio + 1
		if _, err := f.Seek(parcial.inicio, io.SeekStart); err != nil {
			_ = reclamo.Hecho(false)
			errorJSON(w, http.StatusInternalServerError, "Download failed")
			return
		}
	}

	h := w.Header()
	h.Set("Content-Type", reclamo.Meta.MimeType)
	h.Set("Content-Disposition", store.Disposicion(reclamo.Meta.OriginalName, vistaPrevia))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.FormatInt(longitud, 10))
	estado := http.StatusOK
	if parcial != nil {
		h.Set("Content-Range", "bytes "+strconv.FormatInt(parcial.inicio, 10)+"-"+
			strconv.FormatInt(parcial.fin, 10)+"/"+strconv.FormatInt(tamano, 10))
		estado = http.StatusPartialContent
	}
	w.WriteHeader(estado)

	enviados, cerr := copiar(r.Context(), w, io.LimitReader(f, longitud), longitud)
	entregado := cerr == nil && enviados == longitud
	// La contabilidad se cierra ANTES de volver: una transferencia cortada
	// —cliente ido, pestaña cerrada, servicio parando— suelta su plaza y no
	// cuenta. Sólo la entregada cuenta.
	if err := reclamo.Hecho(entregado); err != nil {
		avisar("[docdrop] no se pudo contabilizar la descarga: %v", err)
	}
	if entregado && !vistaPrevia {
		s.almacen.RegistrarTransferencia(id, cliente)
	}
}

// GET /api/info/{id} — lo que puede saber quien recibe antes de descargar.
//
// Público. Dice sólo lo que la página necesita: llegó a devolver el meta.json
// entero, dueño incluido, a cualquiera con el enlace.
//
// De un fichero cifrado lleva además la CABECERA CIFRADA del bulto: los
// primeros bytes, donde viven el nombre, el tipo y el tamaño reales bajo la
// clave. El servidor no puede leerla y nadie sin el fragmento tampoco, así que
// darla no cuesta nada — y es lo que permite ver qué se va a descargar en vez
// de «Encrypted file», sin gastar una descarga.
func (s *Server) info(w http.ResponseWriter, r *http.Request) {
	if res := s.limites.Permitir("info:"+IPCliente(r), 120, time.Minute); !res.Permitido {
		demasiadas(w, res)
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
	if motivo := m.Motivo(s.almacen.Ahora()); motivo != "" {
		texto := "File expired"
		if motivo == store.MotivoAgotado {
			texto = "Max downloads reached"
		}
		escribirJSON(w, http.StatusGone, map[string]any{"error": texto, "reason": motivo})
		return
	}

	respuesta := map[string]any{
		"id":            m.ID,
		"originalName":  m.OriginalName,
		"size":          m.Size,
		"mimeType":      m.MimeType,
		"uploadedAt":    m.UploadedAt,
		"expiresAt":     m.ExpiresAt,
		"downloadCount": m.DownloadCount,
		"maxDownloads":  m.MaxDownloads,
		"encrypted":     m.Encrypted,
	}
	if m.UploadedBy != "" {
		respuesta["uploadedBy"] = m.UploadedBy
	}
	if m.Encrypted {
		if cabecera := s.cabeceraCifrada(id); cabecera != "" {
			respuesta["header"] = cabecera
		}
	}
	escribirJSON(w, http.StatusOK, respuesta)
}

// Una cabecera mayor que esto no es nuestra: dentro sólo hay un nombre y un tipo.
const maxCabeceraE2EE = 64 * 1024

// La magia y la versión del formato del bulto (ver src/lib/e2ee.ts). Aquí sólo
// se comprueba el prefijo EN CLARO: este servidor no descifra nada, y no tiene
// ni puede tener la clave.
var magiaE2EE = []byte("DDE1")

// etiquetaGCM son los 16 bytes de autenticación del cifrado; una cabecera más
// corta que eso no puede serlo.
const etiquetaGCM = 16

// cabeceraCifrada devuelve el prefijo del bulto —magia, tamaño de trozo y
// cabecera cifrada— en base64, o "" si esto no es un bulto nuestro.
func (s *Server) cabeceraCifrada(id string) string {
	ruta, err := s.almacen.RutaBlob(id)
	if err != nil {
		return ""
	}
	f, err := os.Open(ruta)
	if err != nil {
		return ""
	}
	defer f.Close()

	var primeros [12]byte
	if _, err := io.ReadFull(f, primeros[:]); err != nil {
		return ""
	}
	if string(primeros[:4]) != string(magiaE2EE) {
		return ""
	}
	trozoClaro := binary.BigEndian.Uint32(primeros[4:8])
	hdrLen := binary.BigEndian.Uint32(primeros[8:12])
	if trozoClaro < 1024 || hdrLen < etiquetaGCM || hdrLen > maxCabeceraE2EE {
		return ""
	}
	prefijo := make([]byte, 12+int(hdrLen))
	copy(prefijo, primeros[:])
	if _, err := io.ReadFull(f, prefijo[12:]); err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(prefijo)
}
