package uploads

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Ulzuhan/docdrop/internal/store"
)

func banco(t *testing.T) (*store.Store, *Gestor, *time.Time) {
	t.Helper()
	reloj := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	s, err := store.Open(store.Config{Dir: t.TempDir(), Ahora: func() time.Time { return reloj }})
	if err != nil {
		t.Fatal(err)
	}
	return s, Nuevo(s, TrozoMinimo, nil), &reloj
}

func escribirTrozo(t *testing.T, s *store.Store, g *Gestor, ses *Sesion, indice int, relleno byte) {
	t.Helper()
	inicio, fin := RangoParte(ses, indice)
	ruta, _ := s.RutaBlob(ses.ID)
	f, err := os.OpenFile(ruta, os.O_WRONLY, 0o640)
	if err != nil {
		t.Fatal(err)
	}
	datos := make([]byte, fin-inicio)
	for i := range datos {
		datos[i] = relleno
	}
	if _, err := f.WriteAt(datos, inicio); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := g.MarcarParte(ses.ID, indice); err != nil {
		t.Fatal(err)
	}
}

// El fichero se preasigna a su tamaño final: es lo que hace que la cuota vea el
// hueco desde el primer trozo y que cada trozo pueda escribirse en su sitio.
func TestSesionPreasignaYCompleta(t *testing.T) {
	s, g, _ := banco(t)
	ses, err := g.Crear(Entrada{Nombre: "peli.bin", Tamano: TrozoMinimo*2 + 7, TTLHoras: "3"})
	if err != nil {
		t.Fatal(err)
	}
	if ses.TotalParts != 3 {
		t.Fatalf("trozos %d, esperaba 3", ses.TotalParts)
	}
	if s.Usado() != ses.Size {
		t.Fatalf("la cuota ve %d bytes, esperaba %d", s.Usado(), ses.Size)
	}

	// En desorden, como llegan de verdad.
	escribirTrozo(t, s, g, ses, 2, 'c')
	escribirTrozo(t, s, g, ses, 0, 'a')
	if _, faltan, err := g.Completar(ses); err == nil || len(faltan) != 1 || faltan[0] != 1 {
		t.Fatalf("faltando el trozo 1 debería decirlo: %v %v", faltan, err)
	}
	escribirTrozo(t, s, g, ses, 1, 'b')

	meta, _, err := g.Completar(ses)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Size != ses.Size {
		t.Fatalf("tamaño %d, esperaba %d", meta.Size, ses.Size)
	}
	// La entrada pasa a ser un fichero normal: sin sesión y sin marcadores.
	if g.Leer(ses.ID) != nil {
		t.Error("session.json debería haber desaparecido")
	}
	dir, _ := s.DirEntrada(ses.ID)
	if _, err := os.Stat(filepath.Join(dir, "parts")); !os.IsNotExist(err) {
		t.Error("parts/ debería haber desaparecido")
	}
	// El contenido está entero y en orden.
	ruta, _ := s.RutaBlob(ses.ID)
	datos, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatal(err)
	}
	if datos[0] != 'a' || datos[TrozoMinimo] != 'b' || datos[TrozoMinimo*2] != 'c' {
		t.Error("los trozos no quedaron en su sitio")
	}
}

// Cancelar libera el sitio: si no, una subida abandonada se lleva la cuota.
func TestAbortarLiberaElSitio(t *testing.T) {
	s, g, _ := banco(t)
	ses, err := g.Crear(Entrada{Nombre: "x.bin", Tamano: TrozoMinimo})
	if err != nil {
		t.Fatal(err)
	}
	if s.Usado() == 0 {
		t.Fatal("la subida debería ocupar")
	}
	if err := g.Abortar(ses.ID); err != nil {
		t.Fatal(err)
	}
	if s.Usado() != 0 {
		t.Fatalf("cancelar no liberó: %d", s.Usado())
	}
}

// El barrido de sesiones NO puede borrar una entrada que ya tiene ficha.
//
// `Completar` escribe meta.json y DESPUÉS retira session.json. Si esa limpieza
// falla —disco lleno, proceso que muere en medio—, la entrada queda con ficha y
// con sesión. La versión de Node borraba la entrada entera 24 horas más tarde:
// desaparecía un fichero válido, con su enlace ya repartido, y nadie podía
// saber por qué.
func TestBarridoNoBorraUnFicheroTerminado(t *testing.T) {
	s, g, reloj := banco(t)
	ses, err := g.Crear(Entrada{Nombre: "importante.bin", Tamano: 16})
	if err != nil {
		t.Fatal(err)
	}
	escribirTrozo(t, s, g, ses, 0, 'z')
	meta, _, err := g.Completar(ses)
	if err != nil {
		t.Fatal(err)
	}
	// Se reproduce el fallo: la sesión vuelve a estar ahí después de terminar.
	if err := g.escribirSesion(ses); err != nil {
		t.Fatal(err)
	}

	*reloj = reloj.Add(VidaSesion + time.Hour)
	retiradas := g.LimpiarSesiones()

	if len(retiradas) != 0 {
		t.Fatalf("el barrido retiró una entrada con ficha: %v", retiradas)
	}
	if s.LeerMeta(meta.ID) == nil {
		t.Fatal("el fichero terminado ha desaparecido")
	}
	if g.Leer(meta.ID) != nil {
		t.Error("los restos de la sesión deberían haberse retirado")
	}
	ruta, _ := s.RutaBlob(meta.ID)
	if _, err := os.Stat(ruta); err != nil {
		t.Fatalf("el contenido ha desaparecido: %v", err)
	}
}

// Y una subida de verdad abandonada sí se retira.
func TestBarridoRetiraLoAbandonado(t *testing.T) {
	s, g, reloj := banco(t)
	ses, err := g.Crear(Entrada{Nombre: "a-medias.bin", Tamano: TrozoMinimo})
	if err != nil {
		t.Fatal(err)
	}
	*reloj = reloj.Add(VidaSesion + time.Hour)
	if retiradas := g.LimpiarSesiones(); len(retiradas) != 1 || retiradas[0] != ses.ID {
		t.Fatalf("no se retiró la abandonada: %v", retiradas)
	}
	if s.Usado() != 0 {
		t.Fatalf("no liberó el sitio: %d", s.Usado())
	}
}

// EL BARRIDO NO PUEDE BORRAR UNA SUBIDA QUE TERMINA MIENTRAS ÉL ESPERA.
//
// El barrido miraba la sesión, veía que estaba caducada y que no había ficha, y
// decidía borrar. El candado lo tomaba después, con la decisión ya hecha. En esa
// ventana cabía un `Completar`: cuando el barrido por fin entraba, la subida ya
// era un fichero terminado con su enlace repartido, y lo borraba entero.
//
// La ventana se abre a mano porque desde fuera no se puede provocar: dependería
// de quién gane la carrera, y una regresión que depende de eso no es una
// regresión.
func TestBarridoNoBorraUnaSubidaQueTerminaMientrasEspera(t *testing.T) {
	s, g, reloj := banco(t)
	ses, err := g.Crear(Entrada{Nombre: "justo-a-tiempo.bin", Tamano: 16})
	if err != nil {
		t.Fatal(err)
	}
	escribirTrozo(t, s, g, ses, 0, 'z')

	// La sesión caduca: para el vistazo del barrido, esto está abandonado.
	*reloj = reloj.Add(VidaSesion + time.Hour)

	// Y justo entre ese vistazo y el candado, la subida termina.
	var cerrada *store.Meta
	g.pruebaAntesDelCandado = func(string) {
		g.pruebaAntesDelCandado = nil
		var err error
		cerrada, _, err = g.Completar(ses)
		if err != nil {
			t.Errorf("completar: %v", err)
		}
	}

	retiradas := g.LimpiarSesiones()

	if len(retiradas) != 0 {
		t.Fatalf("el barrido borró una subida que acababa de terminar: %v", retiradas)
	}
	if cerrada == nil {
		t.Fatal("la subida no llegó a terminar")
	}
	if s.LeerMeta(ses.ID) == nil {
		t.Fatal("el fichero terminado ha desaparecido")
	}
	ruta, _ := s.RutaBlob(ses.ID)
	if _, err := os.Stat(ruta); err != nil {
		t.Fatalf("el contenido del fichero terminado ha desaparecido: %v", err)
	}
	// Y sin restos: la finalización se los llevó, y el barrido no ha tenido que
	// arreglar nada.
	dir, _ := s.DirEntrada(ses.ID)
	for _, resto := range []string{"parts", "session.json"} {
		if _, err := os.Stat(filepath.Join(dir, resto)); !os.IsNotExist(err) {
			t.Errorf("la entrada terminada conserva %q", resto)
		}
	}
}

// Y si lo que cambia mientras espera es que alguien la cancela, el barrido
// tampoco puede contarla como retirada suya ni tropezar con lo que ya no está.
func TestBarridoConvivConUnaCancelacionEnMedio(t *testing.T) {
	s, g, reloj := banco(t)
	ses, err := g.Crear(Entrada{Nombre: "cancelada.bin", Tamano: 16})
	if err != nil {
		t.Fatal(err)
	}
	*reloj = reloj.Add(VidaSesion + time.Hour)

	g.pruebaAntesDelCandado = func(string) {
		g.pruebaAntesDelCandado = nil
		if err := g.Abortar(ses.ID); err != nil {
			t.Errorf("abortar: %v", err)
		}
	}
	if retiradas := g.LimpiarSesiones(); len(retiradas) != 0 {
		t.Fatalf("el barrido se apuntó una retirada que hizo otro: %v", retiradas)
	}
	dir, _ := s.DirEntrada(ses.ID)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("la entrada cancelada sigue ahí")
	}
}
