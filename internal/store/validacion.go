package store

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Este fichero reproduce la validación de `src/lib/store.ts` con las mismas
// esquinas que tiene en JavaScript. No es purismo: las suites existentes y la
// prueba de compatibilidad comprueban estos valores, y un `Number()` que se
// comporte «razonablemente» en vez de igual cambia el TTL de los ficheros que
// ya se están subiendo cuando se despliegue.

// Indefinido es el centinela de «campo ausente». Hace falta porque `nil` ya
// significa `null`, y JavaScript los trata distinto: `Number(null)` es 0 y
// `Number(undefined)` es NaN. De ahí que subir sin cabecera `x-ttl-hours` dé 1
// hora y llamar a init sin `ttlHours` dé 24.
type indefinido struct{}

var Indefinido any = indefinido{}

// Campo saca un valor de un cuerpo JSON distinguiendo ausente de null.
func Campo(cuerpo map[string]any, clave string) any {
	v, hay := cuerpo[clave]
	if !hay {
		return Indefinido
	}
	return v
}

// numeroJS reproduce `Number(v)` de JavaScript para lo que puede llegar de una
// cabecera HTTP o de un JSON. El booleano es `Number.isFinite`.
//
// Lo que más importa de aquí: `Number(null)` es 0 y `Number(undefined)` es NaN.
// Una cabecera ausente llega como `null` en Node —`headers.get()` devuelve
// null— y un campo ausente de un JSON llega como `undefined`. Por eso subir sin
// `x-ttl-hours` da 1 hora y llamar a `/api/upload/init` sin `ttlHours` da 24:
// no es un descuido de este port, es lo que hace hoy la versión de Node.
func numeroJS(v any) (float64, bool) {
	switch t := v.(type) {
	case nil: // JSON null, o cabecera ausente
		return 0, true
	case indefinido: // campo que no venía en el JSON
		return math.NaN(), false
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	case float64:
		return t, !math.IsNaN(t) && !math.IsInf(t, 0)
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case string:
		return numeroDeCadena(t)
	case []any:
		// ToPrimitive de un array: [] -> "", [x] -> String(x), mas de uno -> NaN.
		switch len(t) {
		case 0:
			return 0, true
		case 1:
			return numeroJS(t[0])
		}
		return math.NaN(), false
	}
	// Un objeto no se convierte a número.
	return math.NaN(), false
}

func numeroDeCadena(s string) (float64, bool) {
	t := RecortarJS(s)
	if t == "" {
		return 0, true
	}
	// `Number("1_000")` es NaN; ParseFloat de Go acepta el guion bajo en algunas
	// formas, así que se descarta antes.
	if strings.ContainsRune(t, '_') {
		return math.NaN(), false
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1), false
	case "-Infinity":
		return math.Inf(-1), false
	}
	// `Number("inf")`, `Number("nan")` y demás son NaN en JavaScript, pero
	// ParseFloat los acepta. Se cortan aquí.
	if bajo := strings.ToLower(t); strings.Contains(bajo, "inf") || strings.Contains(bajo, "nan") {
		return math.NaN(), false
	}
	if len(t) > 2 && t[0] == '0' {
		if base := baseDePrefijo(t[1]); base != 0 {
			n, err := strconv.ParseUint(t[2:], base, 64)
			if err != nil {
				return math.NaN(), false
			}
			return float64(n), true
		}
	}
	n, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN(), false
	}
	return n, !math.IsInf(n, 0)
}

func baseDePrefijo(c byte) int {
	switch c {
	case 'x', 'X':
		return 16
	case 'o', 'O':
		return 8
	case 'b', 'B':
		return 2
	}
	return 0
}

// Lo que recorta `String.prototype.trim`: coincide con `strings.TrimSpace`
// salvo en el BOM, que JavaScript sí recorta y `unicode.IsSpace` no.
const espaciosJS = " \t\n\v\f\r" +
	"\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007" +
	"\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// RecortarJS es `String.prototype.trim`.
func RecortarJS(s string) string { return strings.Trim(s, espaciosJS) }

// Límites del almacén, iguales que en `src/lib/store.ts`.
const (
	MinTTLHoras      = 1
	MaxTTLHoras      = 24 * 30 // 30 días
	MaxLimiteBajadas = 10_000
)

// ClampTTL: horas de vida de un fichero. Ausente en un JSON (`undefined`) da
// 24; ausente en una cabecera (`null`) da 1, porque `Number(null)` es 0.
func ClampTTL(v any) int {
	n, finito := numeroJS(v)
	if !finito {
		return 24
	}
	return int(math.Min(math.Max(math.Floor(n), MinTTLHoras), MaxTTLHoras))
}

// ClampTTLGenerico es el mismo acotado con otros topes: lo usan los enlaces de
// invitado, cuya vida va de 1 hora a 7 días.
func ClampTTLGenerico(v any, porDefecto, minimo, maximo int) int {
	n, finito := numeroJS(v)
	if !finito {
		return porDefecto
	}
	return int(math.Min(math.Max(math.Floor(n), float64(minimo)), float64(maximo)))
}

// ClampBajadas: 0 significa sin límite.
func ClampBajadas(v any) int {
	n, finito := numeroJS(v)
	if !finito || n <= 0 {
		return 0
	}
	return int(math.Min(math.Floor(n), MaxLimiteBajadas))
}

// NombreSeguro: sin rutas, sin caracteres de control, acotado.
//
// El recorte a 255 se hace en unidades UTF-16, como el `slice` de JavaScript.
// Si el corte cae en mitad de un par suplente, aquí se descarta el par entero
// en vez de dejar media unidad suelta: Go no puede representar un suplente
// solitario, y una mitad huérfana no es un nombre mejor que uno sin ella.
func NombreSeguro(bruto string) string {
	base := bruto
	if i := strings.LastIndexAny(base, "/\\"); i >= 0 {
		base = base[i+1:]
	}
	limpio := RecortarJS(sinControles(base))
	if limpio == "" || limpio == "." || limpio == ".." {
		return "file"
	}
	return recortarUTF16(limpio, 255)
}

// EtiquetaSegura es el nombre de quien sube. No es una identidad: sólo se
// limpia para que no rompa la interfaz ni cuele nada raro en la ficha.
func EtiquetaSegura(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return recortarUTF16(RecortarJS(sinControles(s)), 40)
}

func sinControles(s string) string {
	return strings.Map(func(r rune) rune {
		if r <= 0x1f || r == 0x7f {
			return -1
		}
		return r
	}, s)
}

func recortarUTF16(s string, max int) string {
	if len(s) <= max { // si cabe en bytes, cabe en unidades UTF-16
		return s
	}
	unidades := 0
	for i, r := range s {
		ancho := 1
		if r > 0xffff {
			ancho = 2
		}
		if unidades+ancho > max {
			return s[:i]
		}
		unidades += ancho
	}
	return s
}

// Disposicion arma la cabecera Content-Disposition con nombres no ASCII
// (RFC 5987/6266), igual que `contentDisposition` en Node.
func Disposicion(nombre string, enLinea bool) string {
	var ascii strings.Builder
	// Se recorre por unidades UTF-16 porque la expresión regular de JavaScript
	// lo hace: un emoji, que son dos unidades, deja DOS guiones bajos.
	for _, u := range utf16.Encode([]rune(nombre)) {
		if u < 0x20 || u > 0x7e || u == '"' || u == '\\' {
			ascii.WriteByte('_')
			continue
		}
		ascii.WriteByte(byte(u))
	}
	tipo := "attachment"
	if enLinea {
		tipo = "inline"
	}
	return tipo + `; filename="` + ascii.String() + `"; filename*=UTF-8''` + CodificarComponente(nombre)
}

// CodificarComponente es `encodeURIComponent`.
func CodificarComponente(s string) string {
	const seguros = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if strings.IndexByte(seguros, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}

// SeguroEnLinea dice si un tipo se puede servir dentro del navegador.
//
// Servir subidas ajenas `inline` desde el mismo origen es lo que convierte un
// servicio de ficheros en XSS almacenado: basta subir un .html o un .svg con un
// <script>. Sólo se permite multimedia, y SVG queda fuera a propósito porque es
// un documento que puede ejecutar scripts.
func SeguroEnLinea(mime string) bool {
	tipo := strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0]))
	if tipo == "image/svg+xml" {
		return false
	}
	return strings.HasPrefix(tipo, "video/") ||
		strings.HasPrefix(tipo, "audio/") ||
		strings.HasPrefix(tipo, "image/") ||
		tipo == "application/pdf"
}
