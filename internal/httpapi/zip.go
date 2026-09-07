package httpapi

import (
	"archive/zip"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Ulzuhan/docdrop/internal/store"
)

// Tope de ficheros por archivo, para que una URL no dispare una descarga
// desmedida.
const maxEntradasZip = 100

var reNombreZip = regexp.MustCompile(`^[\w \-.]{1,60}$`)

// GET /api/zip?ids=a,b,c[&name=viaje] — varios ficheros en un solo archivo.
//
// Público, como las descargas individuales: quien tenga los enlaces puede
// agruparlos. Va en flujo y sin comprimir, así que empieza a descargarse
// enseguida y no necesita espacio temporal en el servidor.
//
// Cada fichero incluido cuenta como una descarga suya. Los que ya no están
// disponibles se saltan en silencio en vez de tumbar el archivo entero: recibir
// 9 de 10 vídeos es mejor que recibir un error.
//
// LOS BULTOS CIFRADOS NO ENTRAN. Es un cambio frente a 2.3.1, pero de refuerzo:
// el panel ya los excluye —la casilla viene deshabilitada, con su motivo—, así
// que usando el producto no se llegaba aquí. Lo que sí se podía era pedir la URL
// a mano, y entonces el archivo salía con el ciphertext bajo el nombre marcador
// («encrypted»), inservible sin la clave que va en el fragmento de SU enlace, y
// encima gastaba una de sus descargas. Se rechaza la petición entera con un
// motivo, que es lo único que quien la hizo puede accionar.
func (s *Server) zip(w http.ResponseWriter, r *http.Request) {
	if res := s.limites.Permitir("zip:"+IPCliente(r), 30, time.Minute); !res.Permitido {
		demasiadas(w, res)
		return
	}
	crudo := r.URL.Query().Get("ids")
	vistos := map[string]bool{}
	var ids []string
	for _, parte := range strings.Split(crudo, ",") {
		p := strings.TrimSpace(parte)
		if p == "" || vistos[p] {
			continue
		}
		vistos[p] = true
		ids = append(ids, p)
	}

	if len(ids) == 0 {
		errorJSON(w, http.StatusBadRequest, "No ids")
		return
	}
	if len(ids) > maxEntradasZip {
		errorJSON(w, http.StatusBadRequest, "Too many files (max "+strconv.Itoa(maxEntradasZip)+")")
		return
	}
	for _, id := range ids {
		if !store.IDValido(id) {
			errorJSON(w, http.StatusBadRequest, "Invalid id")
			return
		}
	}
	for _, id := range ids {
		if m := s.almacen.LeerMeta(id); m != nil && m.Encrypted {
			errorJSON(w, http.StatusBadRequest,
				"Encrypted files cannot go in an archive: their contents are only readable from their own link.")
			return
		}
	}

	// Las descargas se reclaman por adelantado, para que el contador refleje lo
	// que de verdad se va a mandar y se respeten los límites por fichero.
	type entrada struct {
		nombre  string
		ruta    string
		tamano  int64
		fecha   time.Time
		reclamo *store.Reclamo
	}
	var entradas []entrada
	soltarTodo := func(entregado bool) {
		for _, e := range entradas {
			if err := e.reclamo.Hecho(entregado); err != nil {
				avisar("[docdrop] no se pudo contabilizar una descarga del archivo: %v", err)
			}
		}
	}
	for _, id := range ids {
		reclamo, err := s.almacen.Reclamar(id, true)
		if err != nil {
			continue
		}
		ruta, _ := s.almacen.RutaBlob(id)
		// EL TAMAÑO SALE DEL DISCO, NO DE LA FICHA, y se comprueba que
		// coinciden. Se armaba el archivo con el tamaño de la ficha y se copiaba
		// con un lector acotado a él: si el fichero era más corto —truncado por
		// un fallo de escritura, por un disco lleno— la copia terminaba en EOF
		// sin error, el archivo se cerraba como bueno y cada fichero contaba
		// como descargado. Quien lo abría se llevaba un fichero corto sin que
		// nada se lo dijera, y con su descarga gastada.
		//
		// Un fichero que no cuadra con su ficha se queda fuera y suelta su plaza
		// sin contar, igual que uno que ya no está disponible: recibir 9 de 10
		// sigue siendo mejor que recibir un error, pero recibir 10 con uno
		// mutilado no.
		info, err := os.Stat(ruta)
		if err != nil || info.Size() != reclamo.Meta.Size {
			if err == nil {
				avisar("[docdrop] %s queda fuera del archivo: la ficha dice %d bytes y el fichero tiene %d",
					id, reclamo.Meta.Size, info.Size())
			}
			if err := reclamo.Hecho(false); err != nil {
				avisar("[docdrop] no se pudo soltar la plaza de %s: %v", id, err)
			}
			continue
		}
		entradas = append(entradas, entrada{
			nombre:  reclamo.Meta.OriginalName,
			ruta:    ruta,
			tamano:  info.Size(),
			fecha:   time.UnixMilli(reclamo.Meta.UploadedAt),
			reclamo: reclamo,
		})
	}
	if len(entradas) == 0 {
		errorJSON(w, http.StatusGone, "None of those files are available any more")
		return
	}

	// Dos ficheros pueden llamarse igual; dentro del archivo no.
	nombres := make([]string, len(entradas))
	for i, e := range entradas {
		nombres[i] = e.nombre
	}
	nombres = nombresUnicos(nombres)

	base := "docdrop"
	if pedido := strings.TrimSpace(r.URL.Query().Get("name")); reNombreZip.MatchString(pedido) {
		base = pedido
	}
	sello := s.almacen.Ahora().UTC().Format("2006-01-02")

	h := w.Header()
	h.Set("Content-Type", "application/zip")
	// Sin Content-Length: el tamaño final no se sabe hasta terminar de generar.
	h.Set("Content-Disposition", store.Disposicion(base+"-"+sello+".zip", false))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	// Sin compresión (método «store»): lo que se comparte aquí es vídeo y fotos,
	// ya comprimidos, y pasarlos por deflate quemaría CPU para no ahorrar nada.
	// Así el archivo sale a la velocidad del disco y sólo agrupa ficheros.
	// `archive/zip` pone descriptor de datos y ZIP64 cuando hace falta, que es
	// lo que permite meter un vídeo de 7 GB sin corromper el archivo.
	z := zip.NewWriter(w)
	entero := true
	for i, e := range entradas {
		f, err := os.Open(e.ruta)
		if err != nil {
			entero = false
			break
		}
		cabecera := &zip.FileHeader{Name: nombres[i], Method: zip.Store, Modified: e.fecha}
		destino, err := z.CreateHeader(cabecera)
		if err != nil {
			f.Close()
			entero = false
			break
		}
		enviados, cerr := copiar(r.Context(), destino, io.LimitReader(f, e.tamano), e.tamano)
		f.Close()
		if cerr != nil {
			entero = false
			break
		}
		// Y si se quedó corto entre el stat y la lectura, el archivo NO se
		// cierra: sin su directorio central, quien lo reciba ve un archivo roto,
		// que es la verdad. Cerrarlo entregaría un fichero mutilado con pinta de
		// entero, y encima cobrando la descarga.
		if enviados != e.tamano {
			avisar("[docdrop] %q se quedó en %d de %d bytes; el archivo sale incompleto a propósito",
				nombres[i], enviados, e.tamano)
			entero = false
			break
		}
	}
	if entero {
		if err := z.Close(); err != nil {
			entero = false
		}
	}
	// Cada fichero del archivo cuenta como descargado cuando el archivo ENTERO
	// ha salido; si el cliente corta a mitad, ninguno cuenta y todos sueltan su
	// plaza. Es la misma regla que la descarga individual.
	soltarTodo(entero)
}

// nombresUnicos evita nombres repetidos dentro del archivo: "clip.mp4",
// "clip (2).mp4"…
func nombresUnicos(nombres []string) []string {
	vistos := map[string]int{}
	salida := make([]string, len(nombres))
	for i, nombre := range nombres {
		n := vistos[nombre]
		vistos[nombre] = n + 1
		if n == 0 {
			salida[i] = nombre
			continue
		}
		sufijo := " (" + strconv.Itoa(n+1) + ")"
		if punto := strings.LastIndex(nombre, "."); punto > 0 {
			salida[i] = nombre[:punto] + sufijo + nombre[punto:]
			continue
		}
		salida[i] = nombre + sufijo
	}
	return salida
}
