package store

import (
	"strings"
	"testing"
)

// La tabla no está escrita a mano: son los valores que devuelve el código de
// Node de 2.3.1, extraídos ejecutándolo. Es lo que hace que esto compruebe
// compatibilidad y no la opinión de quien lo escribió.
//
// `nil` es una cabecera ausente (`headers.get()` devuelve null) y `omitido` un
// campo ausente de un JSON (`undefined`). Que den valores distintos es el
// comportamiento real, no un descuido: ver ClampTTL.

type omitido struct{}

func TestClampTTLIgualQueNode(t *testing.T) {
	casos := []struct {
		entrada any
		quiere  int
	}{
		{nil, 1}, {omitido{}, 24}, {"", 1}, {"  ", 1}, {"0", 1}, {"1", 1},
		{"2.9", 2}, {"-5", 1}, {"abc", 24}, {"720", 720}, {"1000", 720},
		{"0x10", 16}, {"1e2", 100}, {"Infinity", 24}, {"-Infinity", 24},
		{"1_0", 24}, {true, 1}, {false, 1}, {3.7, 3},
		{[]any{}, 1}, {[]any{float64(7)}, 7}, {[]any{float64(1), float64(2)}, 24},
		{map[string]any{}, 24},
	}
	for _, c := range casos {
		entrada := c.entrada
		if _, es := entrada.(omitido); es {
			entrada = Indefinido
		}
		if got := ClampTTL(entrada); got != c.quiere {
			t.Errorf("ClampTTL(%#v) = %d, quiere %d", c.entrada, got, c.quiere)
		}
	}
}

func TestClampBajadasIgualQueNode(t *testing.T) {
	casos := []struct {
		entrada any
		quiere  int
	}{
		{nil, 0}, {omitido{}, 0}, {"", 0}, {"0", 0}, {"1", 1}, {"-1", 0},
		{"2.9", 2}, {"10001", 10000}, {"abc", 0}, {"Infinity", 0},
		{float64(0), 0}, {5.9, 5}, {true, 1},
	}
	for _, c := range casos {
		entrada := c.entrada
		if _, es := entrada.(omitido); es {
			entrada = Indefinido
		}
		if got := ClampBajadas(entrada); got != c.quiere {
			t.Errorf("ClampBajadas(%#v) = %d, quiere %d", c.entrada, got, c.quiere)
		}
	}
}

func TestNombreSeguroIgualQueNode(t *testing.T) {
	largo := strings.Repeat("a", 300)
	casos := []struct{ entrada, quiere string }{
		{"a/b/c.txt", "c.txt"},
		{`..\..\x.txt`, "x.txt"},
		{"  espacio  .txt", "espacio  .txt"},
		{".", "file"},
		{"..", "file"},
		{"", "file"},
		{"\x01malo\x7f.txt", "malo.txt"},
		{"ñandú.png", "ñandú.png"},
		{largo, strings.Repeat("a", 255)},
		{"é.txt", "é.txt"},
		{"\U0001f600.png", "\U0001f600.png"},
	}
	for _, c := range casos {
		if got := NombreSeguro(c.entrada); got != c.quiere {
			t.Errorf("NombreSeguro(%q) = %q, quiere %q", c.entrada, got, c.quiere)
		}
	}
}

func TestDisposicionIgualQueNode(t *testing.T) {
	casos := []struct{ entrada, quiere string }{
		{"c.txt", `attachment; filename="c.txt"; filename*=UTF-8''c.txt`},
		{"espacio  .txt", `attachment; filename="espacio  .txt"; filename*=UTF-8''espacio%20%20.txt`},
		{"ñandú.png", `attachment; filename="_and_.png"; filename*=UTF-8''%C3%B1and%C3%BA.png`},
		{"é.txt", `attachment; filename="e_.txt"; filename*=UTF-8''e%CC%81.txt`},
		// Un emoji son DOS unidades UTF-16, así que deja dos guiones bajos.
		{"\U0001f600.png", `attachment; filename="__.png"; filename*=UTF-8''%F0%9F%98%80.png`},
	}
	for _, c := range casos {
		if got := Disposicion(c.entrada, false); got != c.quiere {
			t.Errorf("Disposicion(%q) = %q, quiere %q", c.entrada, got, c.quiere)
		}
	}
	if got := Disposicion("v.mp4", true); !strings.HasPrefix(got, "inline; ") {
		t.Errorf("la vista previa debería ser inline: %q", got)
	}
}

func TestSeguroEnLinea(t *testing.T) {
	for _, tipo := range []string{"video/mp4", "audio/ogg", "image/png", "application/pdf", "IMAGE/JPEG", "video/mp4; codecs=x"} {
		if !SeguroEnLinea(tipo) {
			t.Errorf("%q debería poder verse en línea", tipo)
		}
	}
	for _, tipo := range []string{"image/svg+xml", "text/html", "application/octet-stream", "", "text/plain"} {
		if SeguroEnLinea(tipo) {
			t.Errorf("%q NO debería servirse en línea", tipo)
		}
	}
}
