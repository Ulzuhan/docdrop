// Package store es la única capa de acceso al árbol de datos de DocDrop.
//
// El disco es la ÚNICA fuente de verdad: no hay caché de fichas en memoria.
// Hubo dos en la versión de Node y se separaron entre sí y del disco, así que
// el contador de descargas que enseñaba el panel no era el de verdad.
//
// El formato en disco NO cambia con el port a Go. Es lo que permite volver a la
// imagen de Node sobre los datos que escriba este binario:
//
//	<DATA>/<id>/file          contenido (bulto cifrado si es de punta a punta)
//	<DATA>/<id>/meta.json     ficha
//	<DATA>/<id>/session.json  subida troceada en curso (paquete uploads)
//	<DATA>/<id>/parts/<n>     marcador vacío del trozo n
//	<DATA>/users/…            fichas de usuario (paquete auth)
//	<DATA>/guests/…           enlaces de invitado (paquete auth)
package store

import "time"

// Meta es la ficha de un fichero, tal cual está en meta.json.
//
// El orden de los campos es el mismo que escribe la versión de Node, para que
// un `diff` entre lo que escribe una y otra sea legible.
//
// SOBRE `omitempty`, que aquí no es cosmética:
//
//   - Los opcionales de verdad lo llevan porque Node los escribe ausentes
//     cuando no aplican (`undefined` no llega al JSON). `encrypted` sólo
//     aparece con valor true, nunca false.
//   - Los NUMÉRICOS no lo llevan, y no se les puede poner. Node hace
//     `fresh.downloadCount++` sin comprobar nada: si el campo llegara ausente,
//     eso da `NaN`, se escribe como `null`, y a partir de ahí `maxDownloads`
//     deja de tener efecto y el enlace se puede descargar sin límite. Un
//     `omitempty` en DownloadCount o MaxDownloads es un fallo de seguridad con
//     la vuelta atrás puesta, no un detalle de estilo.
type Meta struct {
	ID            string `json:"id"`
	OriginalName  string `json:"originalName"`
	Size          int64  `json:"size"`
	MimeType      string `json:"mimeType"`
	UploadedAt    int64  `json:"uploadedAt"`
	ExpiresAt     int64  `json:"expiresAt"`
	DownloadCount int    `json:"downloadCount"`
	MaxDownloads  int    `json:"maxDownloads"` // 0 = sin límite
	// Quién la subió. Etiqueta para enseñar, no identidad comprobada.
	UploadedBy string `json:"uploadedBy,omitempty"`
	// De quién es: `user:<id>`. La credencial de verdad, no la etiqueta.
	// Un fichero sin dueño (anterior al campo) no se enseña a nadie: su enlace
	// directo sigue funcionando y la caducidad lo retira solo.
	Owner string `json:"owner,omitempty"`
	// El contenido es un bulto cifrado en el navegador de quien subió. El
	// servidor no puede abrirlo: `OriginalName` y `MimeType` son marcadores y
	// los de verdad viajan dentro, cifrados. Sólo decide qué camino toma la
	// página de descarga.
	Encrypted bool `json:"encrypted,omitempty"`
	// Lápida: el contenido ya está borrado, pero la ficha se conserva un tiempo
	// para poder decir «esto caducó» en vez de un «no existe» indistinguible de
	// un enlace mal copiado.
	BurnedAt     int64  `json:"burnedAt,omitempty"`
	BurnedReason string `json:"burnedReason,omitempty"`
}

// Motivos por los que un fichero deja de poder descargarse.
const (
	MotivoCaducado = "expired"
	MotivoAgotado  = "exhausted"
)

// Cuánto se conservan las lápidas antes de desaparecer del todo.
const VidaLapida = 7 * 24 * time.Hour

// Milisegundos Unix, que es lo que guarda el formato. No son segundos: la
// convención de QR-Forge no vale aquí.
func ms(t time.Time) int64 { return t.UnixMilli() }

func (m *Meta) Caducado(ahora time.Time) bool { return m.ExpiresAt < ms(ahora) }

func (m *Meta) Agotado() bool {
	return m.MaxDownloads > 0 && m.DownloadCount >= m.MaxDownloads
}

func (m *Meta) EsLapida() bool { return m.BurnedAt != 0 }

func (m *Meta) Disponible(ahora time.Time) bool {
	return !m.EsLapida() && !m.Caducado(ahora) && !m.Agotado()
}

// Motivo por el que ya no se puede descargar, o "" si sigue disponible.
func (m *Meta) Motivo(ahora time.Time) string {
	if m.BurnedReason != "" {
		return m.BurnedReason
	}
	if m.Caducado(ahora) {
		return MotivoCaducado
	}
	if m.Agotado() {
		return MotivoAgotado
	}
	return ""
}
