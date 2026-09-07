package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/Ulzuhan/docdrop/internal/auth"
	"github.com/Ulzuhan/docdrop/internal/store"
	"github.com/Ulzuhan/docdrop/internal/uploads"
)

// banco levanta el servicio entero sobre un almacén temporal. Las pruebas van
// por HTTP de verdad, no llamando a los manejadores a mano: lo que se quiere
// comprobar incluye códigos, cabeceras y cuerpos.
type banco struct {
	*Server
	almacen *store.Store
	http    *httptest.Server
	reloj   time.Time
}

func nuevoBanco(t *testing.T) *banco {
	t.Helper()
	dir := t.TempDir()
	b := &banco{reloj: time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)}
	ahora := func() time.Time { return b.reloj }

	almacen, err := store.Open(store.Config{Dir: dir, MaxTotal: 64 * 1024 * 1024, Ahora: ahora})
	if err != nil {
		t.Fatal(err)
	}
	invitados := auth.NuevosInvitados(dir, ahora)
	rev := auth.NuevasRevocaciones(dir, ahora)
	b.almacen = almacen
	b.Server = Nuevo(Piezas{
		Cfg:       Config{},
		Almacen:   almacen,
		Subidas:   uploads.Nuevo(almacen, 1024, invitados.DuenoDe),
		Cuentas:   auth.NuevasCuentas(dir, ahora),
		Invitados: invitados,
		Sesiones:  auth.NuevasSesiones("secreto-de-pruebas-con-treinta-y-dos-bytes", 12, false, rev, ahora),
		Rev:       rev,
		Ahora:     ahora,
	})
	b.http = httptest.NewServer(ConNonce(b.Server))
	t.Cleanup(b.http.Close)
	return b
}

// fichero deja una entrada lista para descargar.
func (b *banco) fichero(t *testing.T, bytes int, maxBajadas int) string {
	t.Helper()
	id, err := store.NuevoID()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.almacen.CrearEntrada(id); err != nil {
		t.Fatal(err)
	}
	ruta, _ := b.almacen.RutaBlob(id)
	contenido := make([]byte, bytes)
	for i := range contenido {
		contenido[i] = byte('a' + i%26)
	}
	if err := os.WriteFile(ruta, contenido, 0o640); err != nil {
		t.Fatal(err)
	}
	ahora := b.reloj
	if err := b.almacen.EscribirMeta(&store.Meta{
		ID: id, OriginalName: "fixture.bin", Size: int64(bytes),
		MimeType:   "application/octet-stream",
		UploadedAt: ahora.UnixMilli(), ExpiresAt: ahora.Add(time.Hour).UnixMilli(),
		MaxDownloads: maxBajadas,
	}); err != nil {
		t.Fatal(err)
	}
	b.almacen.InvalidarUsado()
	return id
}

// pedir hace una petición identificando al cliente con `cliente`, que es lo que
// separa las continuaciones de una IP de las de otra.
func (b *banco) pedir(t *testing.T, metodo, ruta, cliente string, cabeceras map[string]string) *http.Response {
	t.Helper()
	r, err := http.NewRequest(metodo, b.http.URL+ruta, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cliente != "" {
		r.Header.Set("x-forwarded-for", cliente)
	}
	for k, v := range cabeceras {
		r.Header.Set(k, v)
	}
	res, err := b.http.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func (b *banco) descargar(t *testing.T, id, cliente, rango string) (*http.Response, int64) {
	t.Helper()
	cab := map[string]string{}
	if rango != "" {
		cab["Range"] = rango
	}
	res := b.pedir(t, "GET", "/api/download/"+id, cliente, cab)
	n, _ := io.Copy(io.Discard, res.Body)
	res.Body.Close()
	b.asentar(t)
	return res, n
}

// asentar espera a que el manejador termine.
//
// No es una tapadera de una carrera del producto: el cliente ve el último byte
// ANTES de que el servidor cierre su contabilidad, que es justo el orden que se
// quiere —contar después de entregar, no antes—. Sin esperar aquí, la prueba
// leería el contador mientras el manejador todavía lo está escribiendo.
func (b *banco) asentar(t *testing.T) {
	t.Helper()
	if !b.Server.EsperarManejadores(4 * time.Second) {
		t.Fatal("un manejador no terminó")
	}
}

func (b *banco) contador(t *testing.T, id string) int {
	t.Helper()
	m := b.almacen.LeerMeta(id)
	if m == nil {
		t.Fatalf("la ficha de %s ha desaparecido", id)
	}
	return m.DownloadCount
}
