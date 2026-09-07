package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/Ulzuhan/docdrop/internal/uploads"
)

// Las carreras que se pueden provocar desde fuera con dos peticiones.
//
// No son teóricas: las dos llegaron reproducidas. Lo que tienen en común es que
// el fallo no se ve —las peticiones contestan bien— y el daño aparece después,
// en el fichero que alguien se descarga.
//
// El orden entre peticiones se fuerza esperando a que la otra haya ENTRADO en
// su manejador, no con pausas: una prueba de carreras que dependa del reloj pasa
// unas veces y otras no, que es como un fallo así vive años en producción.

// El tamaño de trozo del banco, que es el mínimo que acepta el gestor. Tiene
// que coincidir: si la prueba usara otro, el servidor esperaría un trozo de
// otro tamaño y contestaría 400 por trozo corto.
const trozoPrueba = uploads.TrozoMinimo

func (b *banco) abrirTroceada(t *testing.T, galleta string, trozos int) string {
	t.Helper()
	estado, cuerpo := b.json(t, "POST", "/api/upload/init", map[string]string{"cookie": galleta},
		map[string]any{"filename": "troceada.bin", "size": trozoPrueba * trozos, "ttlHours": 24})
	if estado != http.StatusOK {
		t.Fatalf("init dio %d: %v", estado, cuerpo)
	}
	return cuerpo["uploadId"].(string)
}

func sha256Hex(b []byte) string {
	suma := sha256.Sum256(b)
	return hex.EncodeToString(suma[:])
}

func (b *banco) peticionTrozo(t *testing.T, id string, indice int, cuerpo io.Reader, largo int64, galleta, suma string) *http.Request {
	t.Helper()
	r, err := http.NewRequest("PUT", b.http.URL+"/api/upload/"+id+"/part/"+strconv.Itoa(indice), cuerpo)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("cookie", galleta)
	if suma != "" {
		r.Header.Set("x-chunk-sha256", suma)
	}
	r.ContentLength = largo
	return r
}

// lanzar hace la petición en segundo plano y devuelve por dónde llega su estado.
func (b *banco) lanzar(r *http.Request) <-chan int {
	salida := make(chan int, 1)
	go func() {
		res, err := b.http.Client().Do(r)
		if err != nil {
			salida <- 0
			return
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		salida <- res.StatusCode
	}()
	return salida
}

func (b *banco) completarEnSegundoPlano(t *testing.T, id, galleta string) <-chan int {
	t.Helper()
	r, err := http.NewRequest("POST", b.http.URL+"/api/upload/"+id+"/complete", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("cookie", galleta)
	r.Header.Set("content-type", "application/json")
	return b.lanzar(r)
}

// esperarA da tiempo real a que ocurra algo del servidor. Sólo vale para
// condiciones que, una vez ciertas, siguen siéndolo: una petición que entra y se
// queda dentro, por ejemplo. Para «ha entrado y quizá ya ha salido» no sirve.
func esperarA(t *testing.T, cond func() bool, mensaje string) {
	t.Helper()
	for i := 0; i < 1200; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(mensaje)
}

// atendidaODentro espera a que la petición conteste o a convencerse de que se ha
// quedado esperando.
//
// Hace falta porque la prueba tiene que valer para las dos versiones del código:
// con el candado la petición se queda bloqueada y no contesta; sin él contesta
// enseguida, y entonces mirar «cuántas hay dentro» no sirve —la ventana es de
// microsegundos y el muestreo la pierde—. El plazo sólo decide por cuál de los
// dos caminos se sigue; lo que se afirma después es igual en los dos.
func atendidaODentro(ch <-chan int, plazo time.Duration) (int, bool) {
	select {
	case estado := <-ch:
		return estado, true
	case <-time.After(plazo):
		return 0, false
	}
}

// DOS ESCRITURAS DEL MISMO TROZO, la segunda rechazada por checksum.
//
// Cada trozo se escribe en su posición dentro del fichero final, así que dos
// peticiones del mismo índice escriben EN EL MISMO SITIO. Sin candado se
// entrelazan, y lo peor no es el desorden: la que se RECHAZA por checksum ya ha
// dejado sus bytes puestos. La buena contestaba 200, marcaba el trozo, y el
// fichero que alguien se descargaba llevaba dentro los bytes de la rechazada.
// Medido antes de arreglarlo: medio trozo de basura dentro del fichero.
func TestDosEscriturasDelMismoTrozoNoSeMezclan(t *testing.T) {
	b := nuevoBanco(t)
	galleta := b.cuenta(t, "ana")
	id := b.abrirTroceada(t, galleta, 1)

	bueno := bytes.Repeat([]byte{'A'}, trozoPrueba)
	malo := bytes.Repeat([]byte{'X'}, trozoPrueba)

	// 1. La rechazada entra primero y se queda a medio cuerpo.
	lector, escritor := io.Pipe()
	rechazada := b.lanzar(b.peticionTrozo(t, id, 0, lector, int64(len(malo)), galleta, sha256Hex(bueno)))
	if _, err := escritor.Write(malo[:len(malo)/2]); err != nil {
		t.Fatal(err)
	}
	esperarA(t, func() bool { return b.Server.EnVuelo() >= 1 }, "la escritura rechazada no llegó a empezar")

	// 2. La buena entra con la otra dentro. Con candado espera su turno; sin él
	//    escribe encima ahora mismo.
	canalBuena := b.lanzar(b.peticionTrozo(t, id, 0, bytes.NewReader(bueno), int64(len(bueno)), galleta, sha256Hex(bueno)))
	estadoBuena, atendida := atendidaODentro(canalBuena, 500*time.Millisecond)

	// 3. Y se completa la rechazada, cuyo checksum no cuadra.
	if _, err := escritor.Write(malo[len(malo)/2:]); err != nil {
		t.Fatal(err)
	}
	escritor.Close()

	estadoRechazada := <-rechazada
	if !atendida {
		estadoBuena = <-canalBuena
	}
	b.asentar(t)

	if estadoBuena != http.StatusOK {
		t.Fatalf("la escritura buena dio %d", estadoBuena)
	}
	if estadoRechazada == http.StatusOK && !b.subidas.ParteRecibida(id, 0) {
		t.Fatal("la rechazada dio 200 sin que el trozo estuviera puesto")
	}
	if !b.subidas.ParteRecibida(id, 0) {
		t.Fatal("el trozo bueno no quedó marcado")
	}

	estado, cuerpo := b.json(t, "POST", "/api/upload/"+id+"/complete", map[string]string{"cookie": galleta}, map[string]any{})
	if estado != http.StatusOK {
		t.Fatalf("completar dio %d: %v", estado, cuerpo)
	}
	ruta, _ := b.almacen.RutaBlob(id)
	datos, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(datos, bueno) {
		malos := 0
		for _, c := range datos {
			if c != 'A' {
				malos++
			}
		}
		t.Fatalf("el fichero lleva %d bytes de la escritura rechazada", malos)
	}
}

// El mismo fallo en su forma simple: el trozo bueno ya está puesto y marcado, y
// llega un reenvío con checksum que no cuadra. No puede tocar el fichero.
func TestUnReenvioMaloNoPisaElTrozoBueno(t *testing.T) {
	b := nuevoBanco(t)
	galleta := b.cuenta(t, "ana")
	id := b.abrirTroceada(t, galleta, 1)

	bueno := bytes.Repeat([]byte{'A'}, trozoPrueba)
	if estado := <-b.lanzar(b.peticionTrozo(t, id, 0, bytes.NewReader(bueno), int64(len(bueno)), galleta, sha256Hex(bueno))); estado != http.StatusOK {
		t.Fatalf("el trozo bueno dio %d", estado)
	}
	b.asentar(t)

	malo := bytes.Repeat([]byte{'X'}, trozoPrueba)
	<-b.lanzar(b.peticionTrozo(t, id, 0, bytes.NewReader(malo), int64(len(malo)), galleta, sha256Hex(bueno)))
	b.asentar(t)

	ruta, _ := b.almacen.RutaBlob(id)
	datos, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(datos, bueno) {
		t.Fatal("un reenvío rechazado ha reescrito un trozo que ya estaba bien")
	}
}

// UN TROZO EN VUELO NO PUEDE SOBREVIVIR A COMPLETAR.
//
// `Completar` lee los marcadores, mira el tamaño del fichero y escribe la ficha.
// Un trozo que siguiera escribiendo después metía bytes en un fichero ya
// terminado —con su ficha diciendo otro tamaño y su enlace ya repartido— y
// volvía a crear `parts/` dentro, que es la entrada con ficha y restos que el
// barrido no sabe interpretar.
func TestCompletarNoDejaRestosNiDescuadraLaFicha(t *testing.T) {
	b := nuevoBanco(t)
	galleta := b.cuenta(t, "ana")
	id := b.abrirTroceada(t, galleta, 2)
	cabeceras := map[string]string{"cookie": galleta}

	primero := bytes.Repeat([]byte{'P'}, trozoPrueba)
	if estado := <-b.lanzar(b.peticionTrozo(t, id, 0, bytes.NewReader(primero), int64(len(primero)), galleta, "")); estado != http.StatusOK {
		t.Fatalf("el primer trozo dio %d", estado)
	}
	b.asentar(t)

	// El segundo trozo, dos veces y a la vez con una a medio cuerpo, y
	// completar entrando en medio. Es el orden que corrompía.
	unaA := bytes.Repeat([]byte{'A'}, trozoPrueba)
	unaB := bytes.Repeat([]byte{'B'}, trozoPrueba)
	lector, escritor := io.Pipe()
	primeraA := b.lanzar(b.peticionTrozo(t, id, 1, lector, int64(len(unaA)), galleta, ""))
	if _, err := escritor.Write(unaA[:len(unaA)/2]); err != nil {
		t.Fatal(err)
	}
	esperarA(t, func() bool { return b.Server.EnVuelo() >= 1 }, "el trozo no llegó a empezar")

	segundaB := b.lanzar(b.peticionTrozo(t, id, 1, bytes.NewReader(unaB), int64(len(unaB)), galleta, ""))
	_, atendidaB := atendidaODentro(segundaB, 300*time.Millisecond)

	cerrar := b.completarEnSegundoPlano(t, id, galleta)
	estadoCerrar, atendidoCierre := atendidaODentro(cerrar, 300*time.Millisecond)

	if _, err := escritor.Write(unaA[len(unaA)/2:]); err != nil {
		t.Fatal(err)
	}
	escritor.Close()
	<-primeraA
	if !atendidaB {
		<-segundaB
	}
	if !atendidoCierre {
		estadoCerrar = <-cerrar
	}
	b.asentar(t)

	// Un cliente reintenta el cierre si le dicen que faltan trozos.
	if estadoCerrar == http.StatusConflict {
		if estado, cuerpo := b.json(t, "POST", "/api/upload/"+id+"/complete", cabeceras, map[string]any{}); estado != http.StatusOK {
			t.Fatalf("el reintento de completar dio %d: %v", estado, cuerpo)
		}
	} else if estadoCerrar != http.StatusOK {
		t.Fatalf("completar dio %d", estadoCerrar)
	}

	// La entrada terminada no puede conservar restos de la subida.
	dir, _ := b.almacen.DirEntrada(id)
	for _, resto := range []string{"parts", "session.json"} {
		if _, err := os.Stat(filepath.Join(dir, resto)); !os.IsNotExist(err) {
			t.Errorf("la entrada terminada conserva %q", resto)
		}
	}

	// La ficha tiene que describir lo que hay de verdad en disco.
	ruta, _ := b.almacen.RutaBlob(id)
	info, err := os.Stat(ruta)
	if err != nil {
		t.Fatal(err)
	}
	m := b.almacen.LeerMeta(id)
	if m == nil || m.Size != info.Size() {
		t.Fatalf("la ficha dice %v y el fichero tiene %d bytes", m, info.Size())
	}

	// Y el trozo tiene que ser de UNA de las dos escrituras, no de las dos.
	datos, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatal(err)
	}
	segundo := datos[trozoPrueba:]
	if !bytes.Equal(segundo, unaA) && !bytes.Equal(segundo, unaB) {
		aes, bes := bytes.Count(segundo, []byte{'A'}), bytes.Count(segundo, []byte{'B'})
		t.Fatalf("el trozo mezcla las dos escrituras: %d bytes de una y %d de la otra", aes, bes)
	}
	if !bytes.Equal(datos[:trozoPrueba], primero) {
		t.Fatal("el primer trozo ha cambiado")
	}
}

// Y cancelar tampoco puede llevarse por delante un trozo a medio escribir: el
// que llegara tarde volvería a crear el directorio de una subida ya cancelada.
func TestCancelarNoDejaResucitarLaEntrada(t *testing.T) {
	b := nuevoBanco(t)
	galleta := b.cuenta(t, "ana")
	id := b.abrirTroceada(t, galleta, 1)

	lector, escritor := io.Pipe()
	trozo := b.lanzar(b.peticionTrozo(t, id, 0, lector, trozoPrueba, galleta, ""))
	if _, err := escritor.Write(bytes.Repeat([]byte{'A'}, trozoPrueba/2)); err != nil {
		t.Fatal(err)
	}
	esperarA(t, func() bool { return b.Server.EnVuelo() >= 1 }, "el trozo no llegó a empezar")

	r, err := http.NewRequest("DELETE", b.http.URL+"/api/upload/"+id, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("cookie", galleta)
	canalBorrar := b.lanzar(r)
	estadoBorrar, atendido := atendidaODentro(canalBorrar, 300*time.Millisecond)

	if _, err := escritor.Write(bytes.Repeat([]byte{'A'}, trozoPrueba/2)); err != nil {
		t.Fatal(err)
	}
	escritor.Close()
	<-trozo
	if !atendido {
		estadoBorrar = <-canalBorrar
	}
	if estadoBorrar != http.StatusOK {
		t.Fatalf("cancelar dio %d", estadoBorrar)
	}
	b.asentar(t)

	dir, _ := b.almacen.DirEntrada(id)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		entradas, _ := os.ReadDir(dir)
		var nombres []string
		for _, e := range entradas {
			nombres = append(nombres, e.Name())
		}
		t.Fatalf("la subida cancelada dejó %v", nombres)
	}
	if b.almacen.Usado() != 0 {
		t.Fatalf("cancelar no liberó el sitio: %d", b.almacen.Usado())
	}
}

// Cuatro «complete» a la vez no pueden dejar el almacén descuadrado.
//
// Lo que se afirma es lo que importa, no un código concreto: ninguno puede
// fallar con un 500, y al final tiene que haber UNA ficha que describa el
// fichero que hay en disco. Que los que llegan tarde reciban 404 —porque el
// primero ya retiró la sesión— es lo que hace también la versión de Node, y no
// se cambia aquí.
//
// Antes de coordinarlos, esto daba 409 y dos 500: el que ganaba retiraba los
// restos mientras los otros seguían leyéndolos.
func TestDosCompletarALaVez(t *testing.T) {
	b := nuevoBanco(t)
	galleta := b.cuenta(t, "ana")
	id := b.abrirTroceada(t, galleta, 1)
	datos := bytes.Repeat([]byte{'A'}, trozoPrueba)
	if estado := <-b.lanzar(b.peticionTrozo(t, id, 0, bytes.NewReader(datos), int64(len(datos)), galleta, "")); estado != http.StatusOK {
		t.Fatalf("el trozo dio %d", estado)
	}
	b.asentar(t)

	var espera sync.WaitGroup
	estados := make([]int, 4)
	for i := range estados {
		espera.Add(1)
		go func(n int) {
			defer espera.Done()
			estados[n] = <-b.completarEnSegundoPlano(t, id, galleta)
		}(i)
	}
	espera.Wait()
	b.asentar(t)

	correctos := 0
	for i, e := range estados {
		switch e {
		case http.StatusOK:
			correctos++
		case http.StatusNotFound:
			// Llegó cuando el primero ya había retirado la sesión.
		default:
			t.Errorf("el cierre %d dio %d", i, e)
		}
	}
	if correctos == 0 {
		t.Fatal("ninguno de los cierres terminó bien")
	}
	m := b.almacen.LeerMeta(id)
	if m == nil {
		t.Fatal("sin ficha")
	}
	ruta, _ := b.almacen.RutaBlob(id)
	info, err := os.Stat(ruta)
	if err != nil {
		t.Fatal(err)
	}
	if m.Size != info.Size() {
		t.Fatalf("la ficha dice %d y el fichero tiene %d", m.Size, info.Size())
	}
}
