package main

import (
	"context"
	"errors"
	"io"
	stdLog "log"
	"net"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/Ulzuhan/docdrop/internal/auth"
	"github.com/Ulzuhan/docdrop/internal/httpapi"
	"github.com/Ulzuhan/docdrop/internal/store"
	"github.com/Ulzuhan/docdrop/internal/uploads"
)

// La parada, probada de verdad y en milisegundos.
//
// Lo que se comprueba no es que el proceso termine —eso lo hace cualquier
// `exit`— sino que al terminar el almacén queda como si la transferencia
// cortada no hubiera existido: la descarga no cuenta, la reserva se suelta, el
// trozo a medias no se marca. Y que todo eso cabe en el presupuesto.

type montaje struct {
	almacen *store.Store
	api     *httpapi.Server
	srv     *http.Server
	base    context.CancelFunc
	tareas  context.CancelFunc
	hecho   chan struct{}
	url     string
	reloj   time.Time
}

func montar(t *testing.T) *montaje {
	t.Helper()
	dir := t.TempDir()
	m := &montaje{reloj: time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC), hecho: make(chan struct{})}
	ahora := func() time.Time { return m.reloj }

	almacen, err := store.Open(store.Config{Dir: dir, MaxTotal: 8 * 1024 * 1024, Ahora: ahora})
	if err != nil {
		t.Fatal(err)
	}
	invitados := auth.NuevosInvitados(dir, ahora)
	rev := auth.NuevasRevocaciones(dir, ahora)
	api := httpapi.Nuevo(httpapi.Piezas{
		Almacen:   almacen,
		Subidas:   uploads.Nuevo(almacen, uploads.TrozoMinimo, invitados.DuenoDe),
		Cuentas:   auth.NuevasCuentas(dir, ahora),
		Invitados: invitados,
		Sesiones:  auth.NuevasSesiones("secreto-de-pruebas-con-treinta-y-dos-bytes", 12, false, rev, ahora),
		Rev:       rev,
		Ahora:     ahora,
	})
	base, cancelarBase := context.WithCancel(context.Background())
	_, pararTareas := context.WithCancel(context.Background())
	close(m.hecho) // sin barrido en marcha: lo suyo se prueba aparte

	escucha, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler:     httpapi.ConNonce(api),
		BaseContext: func(net.Listener) context.Context { return base },
		ErrorLog:    apagarRegistro(),
	}
	go srv.Serve(escucha)

	m.almacen, m.api, m.srv = almacen, api, srv
	m.base, m.tareas = cancelarBase, pararTareas
	m.url = "http://" + escucha.Addr().String()
	return m
}

func (m *montaje) parar(p Plazos) time.Duration {
	inicio := time.Now()
	apagar(m.srv, m.api, m.almacen, m.base, m.tareas, m.hecho, p)
	return time.Since(inicio)
}

func plazosCortos() Plazos {
	return Plazos{Total: 600 * time.Millisecond, Gracia: 100 * time.Millisecond,
		Manejadores: 100 * time.Millisecond, Tareas: 50 * time.Millisecond}
}

func (m *montaje) fichero(t *testing.T, bytes int, maxBajadas int) string {
	t.Helper()
	id, err := store.NuevoID()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.almacen.CrearEntrada(id); err != nil {
		t.Fatal(err)
	}
	ruta, _ := m.almacen.RutaBlob(id)
	if err := os.WriteFile(ruta, make([]byte, bytes), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := m.almacen.EscribirMeta(&store.Meta{
		ID: id, OriginalName: "grande.bin", Size: int64(bytes), MimeType: "application/octet-stream",
		UploadedAt: m.reloj.UnixMilli(), ExpiresAt: m.reloj.Add(time.Hour).UnixMilli(),
		MaxDownloads: maxBajadas,
	}); err != nil {
		t.Fatal(err)
	}
	m.almacen.InvalidarUsado()
	return id
}

// Una descarga en vuelo cortada por la parada no cuenta y suelta su plaza.
func TestParadaCortaLaDescargaSinContarla(t *testing.T) {
	m := montar(t)
	id := m.fichero(t, 8*1024*1024, 1)

	res, err := http.Get(m.url + "/api/download/" + id)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	// Se lee un poco: la transferencia está viva y a medias.
	if _, err := io.CopyN(io.Discard, res.Body, 4096); err != nil {
		t.Fatal(err)
	}

	tardanza := m.parar(plazosCortos())
	if tardanza > 2*time.Second {
		t.Fatalf("la parada tardó %s: no cabe en el presupuesto del contenedor", tardanza)
	}
	if meta := m.almacen.LeerMeta(id); meta == nil || meta.DownloadCount != 0 {
		t.Fatalf("una descarga cortada por la parada contó: %+v", meta)
	}
	// La plaza se soltó: el candado de ese id ya no tiene a nadie.
	if p := m.almacen.Pendientes(); p != 0 {
		t.Fatalf("quedan %d colas por id", p)
	}
	// Y el almacén está cerrado, así que nada puede escribir después.
	if err := m.almacen.EscribirMeta(&store.Meta{ID: id}); !errors.Is(err, store.ErrCerrado) {
		t.Fatalf("el almacén debería estar cerrado, dio %v", err)
	}
}

// Una subida en vuelo cortada por la parada suelta su reserva de espacio.
func TestParadaSueltaLaReservaDeLaSubida(t *testing.T) {
	m := montar(t)
	lector, escritor := io.Pipe()
	defer escritor.Close()

	pedir, err := http.NewRequest("POST", m.url+"/api/upload", lector)
	if err != nil {
		t.Fatal(err)
	}
	pedir.Header.Set("x-filename", "lenta.bin")
	pedir.Header.Set("content-type", "application/octet-stream")
	// Sin sesión no se sube; se firma una cookie con el mismo secreto de prueba
	// y se siembra la ficha en disco, como hacen las suites.
	pedir.Header.Set("cookie", cookieDePrueba(t, m))

	hecho := make(chan struct{})
	go func() {
		defer close(hecho)
		res, err := http.DefaultClient.Do(pedir)
		if err == nil {
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}
	}()
	// Unos bytes para que el manejador ya tenga la reserva puesta.
	if _, err := escritor.Write(make([]byte, 64*1024)); err != nil {
		t.Fatal(err)
	}
	esperarHasta(t, func() bool { return m.almacen.Reservados() > 0 }, "la subida no llegó a reservar")

	tardanza := m.parar(plazosCortos())
	if tardanza > 2*time.Second {
		t.Fatalf("la parada tardó %s", tardanza)
	}
	if r := m.almacen.Reservados(); r != 0 {
		t.Fatalf("la parada dejó %d bytes reservados para siempre", r)
	}
	// Y no quedó basura: la entrada a medias se borró.
	if len(m.almacen.ListarMeta()) != 0 {
		t.Fatal("la subida cortada dejó una ficha")
	}
	escritor.Close()
	<-hecho
}

// Un trozo cortado por la parada NO queda marcado como recibido: si quedara, el
// cliente daría por bueno un trozo a medias y el fichero saldría corrupto.
func TestParadaNoMarcaUnTrozoAMedias(t *testing.T) {
	m := montar(t)
	galleta := cookieDePrueba(t, m)

	subidas := uploads.Nuevo(m.almacen, uploads.TrozoMinimo, nil)
	ses, err := subidas.Crear(uploads.Entrada{Nombre: "troceada.bin", Tamano: uploads.TrozoMinimo * 2})
	if err != nil {
		t.Fatal(err)
	}

	lector, escritor := io.Pipe()
	defer escritor.Close()
	pedir, err := http.NewRequest("PUT", m.url+"/api/upload/"+ses.ID+"/part/0", lector)
	if err != nil {
		t.Fatal(err)
	}
	pedir.Header.Set("cookie", galleta)
	hecho := make(chan struct{})
	go func() {
		defer close(hecho)
		if res, err := http.DefaultClient.Do(pedir); err == nil {
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}
	}()
	if _, err := escritor.Write(make([]byte, 64*1024)); err != nil {
		t.Fatal(err)
	}
	esperarHasta(t, func() bool { return m.api.EnVuelo() > 0 }, "el trozo no llegó a empezar")

	m.parar(plazosCortos())

	if subidas.ParteRecibida(ses.ID, 0) {
		t.Fatal("un trozo cortado a mitad quedó marcado como recibido")
	}
	escritor.Close()
	<-hecho
}

// El presupuesto se respeta aunque un manejador no responda: se corta y se
// sigue, porque el contenedor no espera.
func TestLaParadaCabeEnElPresupuesto(t *testing.T) {
	m := montar(t)
	id := m.fichero(t, 8*1024*1024, 0)
	res, err := http.Get(m.url + "/api/download/" + id)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if _, err := io.CopyN(io.Discard, res.Body, 1024); err != nil {
		t.Fatal(err)
	}

	p := Plazos{Total: 400 * time.Millisecond, Gracia: 100 * time.Millisecond,
		Manejadores: 100 * time.Millisecond, Tareas: 50 * time.Millisecond}
	if tardanza := m.parar(p); tardanza > time.Second {
		t.Fatalf("la parada tardó %s con un presupuesto de %s", tardanza, p.Total)
	}
}

func esperarHasta(t *testing.T, cond func() bool, mensaje string) {
	t.Helper()
	for i := 0; i < 400; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(mensaje)
}

// cookieDePrueba siembra una cuenta en disco y firma su sesión, igual que hacen
// las suites: `exigirSesion` no se cree la cookie, busca la ficha.
func cookieDePrueba(t *testing.T, m *montaje) string {
	t.Helper()
	cuentas := auth.NuevasCuentas(m.almacen.Dir(), func() time.Time { return m.reloj })
	nombre := "Prueba"
	u, err := cuentas.Registrar(auth.Identidad{Sub: "sub-de-pruebas", Email: "prueba@example.invalid", Name: &nombre})
	if err != nil {
		t.Fatal(err)
	}
	sesiones := auth.NuevasSesiones("secreto-de-pruebas-con-treinta-y-dos-bytes", 12, false, nil, func() time.Time { return m.reloj })
	return auth.CookieSesion + "=" + sesiones.Crear(u.ID)
}

func apagarRegistro() *stdLog.Logger { return stdLog.New(io.Discard, "", 0) }
