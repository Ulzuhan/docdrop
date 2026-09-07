package httpapi

import (
	"io"
	"net/http"
	"os"
	"testing"
)

// Un rango inválido ni reserva plaza ni habilita descargas gratis.
//
// La comprobación anterior era «el rango no empieza en el byte 0», y se
// escapaba: `bytes=1-` devolvía todo menos el primer byte y `bytes=-<tamaño>`
// el fichero ENTERO, las dos sin contar y tantas veces como se pidiera.
func TestRangoInvalidoNoReservaNiRegala(t *testing.T) {
	for _, rango := range []string{"bytes=invalid", "bytes=", "bytes=-0", "bytes=14-", "bytes=3-2", "bytes=9007199254740992-"} {
		t.Run(rango, func(t *testing.T) {
			b := nuevoBanco(t)
			id := b.fichero(t, 14, 1)
			res, _ := b.descargar(t, id, id, rango)
			if res.StatusCode != http.StatusRequestedRangeNotSatisfiable {
				t.Fatalf("%s dio %d, esperaba 416", rango, res.StatusCode)
			}
			if quiere := "bytes */14"; res.Header.Get("Content-Range") != quiere {
				t.Errorf("Content-Range = %q, quiere %q", res.Header.Get("Content-Range"), quiere)
			}
			if b.almacen.TransferenciaReanudada(id, id) {
				t.Fatal("un rango inválido no puede dar continuación")
			}
			res, n := b.descargar(t, id, id, "bytes=0-")
			if res.StatusCode != http.StatusPartialContent || n != 14 {
				t.Fatalf("la descarga siguiente dio %d con %d bytes", res.StatusCode, n)
			}
			if c := b.contador(t, id); c != 1 {
				t.Fatalf("contador %d, esperaba 1", c)
			}
			res, _ = b.descargar(t, id, id, "bytes=0-")
			if res.StatusCode != http.StatusGone {
				t.Fatalf("con el cupo agotado dio %d, esperaba 410", res.StatusCode)
			}
		})
	}
}

// Cortar una respuesta suelta su plaza, no cuenta, y el reintento por rango
// tiene que pagar su propia descarga.
func TestTransferenciaCortadaNiCuentaNiRegala(t *testing.T) {
	b := nuevoBanco(t)
	id := b.fichero(t, 1<<20, 1)

	res := b.pedir(t, "GET", "/api/download/"+id, id, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("estado %d", res.StatusCode)
	}
	// Se lee un poco y se corta, como una pestaña que se cierra a mitad.
	if _, err := io.CopyN(io.Discard, res.Body, 4096); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	b.asentar(t)

	if c := b.contador(t, id); c != 0 {
		t.Fatalf("una transferencia cortada contó: %d", c)
	}
	if b.almacen.TransferenciaReanudada(id, id) {
		t.Fatal("una transferencia cortada no puede dar continuación")
	}
	res, n := b.descargar(t, id, id, "bytes=0-")
	if res.StatusCode != http.StatusPartialContent || n != 1<<20 {
		t.Fatalf("el reintento dio %d con %d bytes", res.StatusCode, n)
	}
	if c := b.contador(t, id); c != 1 {
		t.Fatalf("el reintento debería contar: %d", c)
	}
	res, _ = b.descargar(t, id, id, "")
	if res.StatusCode != http.StatusGone {
		t.Fatalf("el cupo debería estar agotado, dio %d", res.StatusCode)
	}
}

// Sólo una respuesta contabilizada da continuaciones a ESE cliente.
func TestContinuacionesSoloTrasContabilizar(t *testing.T) {
	b := nuevoBanco(t)
	id := b.fichero(t, 14, 3)

	res, n := b.descargar(t, id, "1.2.3.4", "bytes=0-3")
	if res.StatusCode != http.StatusPartialContent || n != 4 {
		t.Fatalf("primer trozo: %d con %d bytes", res.StatusCode, n)
	}
	if c := b.contador(t, id); c != 1 {
		t.Fatalf("contador %d, esperaba 1", c)
	}
	if !b.almacen.TransferenciaReanudada(id, "1.2.3.4") {
		t.Fatal("quien pagó debería poder continuar")
	}
	if b.almacen.TransferenciaReanudada(id, "9.9.9.9") {
		t.Fatal("la continuación no es de otro cliente")
	}
	_, n = b.descargar(t, id, "1.2.3.4", "bytes=4-")
	if n != 10 {
		t.Fatalf("la continuación trajo %d bytes", n)
	}
	if c := b.contador(t, id); c != 1 {
		t.Fatalf("la continuación no debe contar: %d", c)
	}
	// Otro cliente con el mismo rango sí paga.
	b.descargar(t, id, "9.9.9.9", "bytes=4-")
	if c := b.contador(t, id); c != 2 {
		t.Fatalf("el cliente nuevo debería pagar: %d", c)
	}
}

// Un blob que falta no reserva plaza.
func TestBlobQueFaltaNoReserva(t *testing.T) {
	b := nuevoBanco(t)
	id := b.fichero(t, 14, 1)
	ruta, _ := b.almacen.RutaBlob(id)
	if err := os.Remove(ruta); err != nil {
		t.Fatal(err)
	}
	res, _ := b.descargar(t, id, id, "")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("dio %d, esperaba 404", res.StatusCode)
	}
	if b.almacen.TransferenciaReanudada(id, id) {
		t.Fatal("no puede haber continuación")
	}
	if err := os.WriteFile(ruta, make([]byte, 14), 0o640); err != nil {
		t.Fatal(err)
	}
	res, n := b.descargar(t, id, id, "")
	if res.StatusCode != http.StatusOK || n != 14 {
		t.Fatalf("dio %d con %d bytes", res.StatusCode, n)
	}
}

// La vista previa ni cuenta ni ocupa plaza, y sólo vale para tipos seguros.
func TestVistaPreviaNoCuenta(t *testing.T) {
	b := nuevoBanco(t)
	id := b.fichero(t, 32, 1)
	m := b.almacen.LeerMeta(id)
	m.MimeType = "video/mp4"
	if err := b.almacen.EscribirMeta(m); err != nil {
		t.Fatal(err)
	}
	res := b.pedir(t, "GET", "/api/download/"+id+"?inline=1", "1.2.3.4", nil)
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	b.asentar(t)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("estado %d", res.StatusCode)
	}
	if got := res.Header.Get("Content-Disposition"); got[:6] != "inline" {
		t.Errorf("Content-Disposition = %q", got)
	}
	if c := b.contador(t, id); c != 0 {
		t.Fatalf("la vista previa contó: %d", c)
	}
	if b.almacen.TransferenciaReanudada(id, "1.2.3.4") {
		t.Fatal("la vista previa no registra continuación")
	}

	// Un tipo peligroso NO se sirve en línea: eso convertiría el servicio en
	// XSS almacenado.
	m.MimeType = "image/svg+xml"
	if err := b.almacen.EscribirMeta(m); err != nil {
		t.Fatal(err)
	}
	res = b.pedir(t, "GET", "/api/download/"+id+"?inline=1", "5.6.7.8", nil)
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	b.asentar(t)
	if got := res.Header.Get("Content-Disposition"); got[:10] != "attachment" {
		t.Errorf("un SVG debería bajarse, no verse: %q", got)
	}
}
