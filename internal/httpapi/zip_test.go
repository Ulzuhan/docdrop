package httpapi

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"os"
	"testing"
)

func TestZipAgrupaYCuentaAlTerminar(t *testing.T) {
	b := nuevoBanco(t)
	// Lo bastante grandes para que la respuesta salga en flujo: por debajo del
	// búfer del servidor, Go calcula la longitud porque ya la tiene, y eso no
	// es el caso que importa aquí.
	uno := b.fichero(t, 4096, 1)
	dos := b.fichero(t, 8192, 1)

	res := b.pedir(t, "GET", "/api/zip?ids="+uno+","+dos+"&name=viaje", "1.2.3.4", nil)
	cuerpo, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	b.asentar(t)

	if res.StatusCode != http.StatusOK {
		t.Fatalf("estado %d", res.StatusCode)
	}
	if tipo := res.Header.Get("Content-Type"); tipo != "application/zip" {
		t.Errorf("tipo %q", tipo)
	}
	if d := res.Header.Get("Content-Disposition"); !bytes.Contains([]byte(d), []byte("viaje-")) {
		t.Errorf("Content-Disposition = %q", d)
	}
	// Sin Content-Length: el tamaño final no se sabe hasta terminar de generar,
	// que es lo que permite empezar a descargar un archivo de gigas al momento.
	if res.Header.Get("Content-Length") != "" {
		t.Errorf("no debería anunciar longitud: %q", res.Header.Get("Content-Length"))
	}

	archivo, err := zip.NewReader(bytes.NewReader(cuerpo), int64(len(cuerpo)))
	if err != nil {
		t.Fatalf("el archivo no abre: %v", err)
	}
	if len(archivo.File) != 2 {
		t.Fatalf("entradas %d, esperaba 2", len(archivo.File))
	}
	// Dos ficheros pueden llamarse igual; dentro del archivo no.
	if archivo.File[0].Name == archivo.File[1].Name {
		t.Errorf("nombres repetidos dentro del archivo: %q", archivo.File[0].Name)
	}
	total := 0
	for _, f := range archivo.File {
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		datos, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
		total += len(datos)
	}
	if total != 4096+8192 {
		t.Fatalf("el archivo trae %d bytes, esperaba %d", total, 4096+8192)
	}
	// Cada fichero incluido cuenta como una descarga suya, y al agotarse queda
	// como lápida.
	for _, id := range []string{uno, dos} {
		m := b.almacen.LeerMeta(id)
		if m == nil || m.DownloadCount != 1 {
			t.Fatalf("%s: contador %+v", id, m)
		}
	}
}

// Los que ya no están disponibles se saltan en silencio en vez de tumbar el
// archivo entero: recibir 9 de 10 vídeos es mejor que recibir un error.
func TestZipSaltaLoNoDisponible(t *testing.T) {
	b := nuevoBanco(t)
	vivo := b.fichero(t, 50, 0)
	agotado := b.fichero(t, 50, 1)
	m := b.almacen.LeerMeta(agotado)
	m.DownloadCount = 1
	if err := b.almacen.EscribirMeta(m); err != nil {
		t.Fatal(err)
	}

	res := b.pedir(t, "GET", "/api/zip?ids="+vivo+","+agotado, "1.2.3.4", nil)
	cuerpo, _ := io.ReadAll(res.Body)
	res.Body.Close()
	b.asentar(t)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("estado %d", res.StatusCode)
	}
	archivo, err := zip.NewReader(bytes.NewReader(cuerpo), int64(len(cuerpo)))
	if err != nil {
		t.Fatal(err)
	}
	if len(archivo.File) != 1 {
		t.Fatalf("entradas %d, esperaba 1", len(archivo.File))
	}
}

// Un bulto cifrado no entra, y se dice por qué: el archivo saldría con
// ciphertext inservible y gastaría una descarga de cada uno.
func TestZipRechazaLosCifrados(t *testing.T) {
	b := nuevoBanco(t)
	claro := b.fichero(t, 50, 1)
	cifrado := b.fichero(t, 50, 1)
	m := b.almacen.LeerMeta(cifrado)
	m.Encrypted = true
	m.OriginalName = "encrypted"
	if err := b.almacen.EscribirMeta(m); err != nil {
		t.Fatal(err)
	}

	res := b.pedir(t, "GET", "/api/zip?ids="+claro+","+cifrado, "1.2.3.4", nil)
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	b.asentar(t)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("estado %d, esperaba 400", res.StatusCode)
	}
	// Y ninguno gastó descarga.
	for _, id := range []string{claro, cifrado} {
		if c := b.contador(t, id); c != 0 {
			t.Fatalf("%s gastó una descarga: %d", id, c)
		}
	}
}

func TestZipValidaLaPeticion(t *testing.T) {
	b := nuevoBanco(t)
	casos := []struct {
		ruta   string
		estado int
	}{
		{"/api/zip", http.StatusBadRequest},
		{"/api/zip?ids=", http.StatusBadRequest},
		{"/api/zip?ids=no-es-un-id", http.StatusBadRequest},
		{"/api/zip?ids=../../etc", http.StatusBadRequest},
		{"/api/zip?ids=aaaaaaaaaaaa", http.StatusGone},
	}
	for _, c := range casos {
		res := b.pedir(t, "GET", c.ruta, "1.2.3.4", nil)
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != c.estado {
			t.Errorf("%s dio %d, esperaba %d", c.ruta, res.StatusCode, c.estado)
		}
	}
}

// UN FICHERO MÁS CORTO QUE SU FICHA NO PUEDE SALIR EN UN ARCHIVO COMPLETO.
//
// El ZIP se armaba con el tamaño de la ficha y copiaba con un lector acotado a
// ese tamaño: si el fichero en disco era más corto —truncado por un fallo de
// escritura, por un disco lleno, por una subida que no terminó de cuadrar— la
// copia terminaba en EOF sin error, el archivo se cerraba como bueno, y **cada
// fichero contaba como descargado**. Quien lo abría se llevaba un fichero corto
// sin que nada se lo dijera, y con su descarga gastada.
func TestZipRechazaUnFicheroMasCortoQueSuFicha(t *testing.T) {
	b := nuevoBanco(t)
	entero := b.fichero(t, 8192, 1)
	corto := b.fichero(t, 8192, 1)

	// El de disco se queda a la mitad; la ficha sigue diciendo 8192.
	ruta, _ := b.almacen.RutaBlob(corto)
	if err := os.Truncate(ruta, 4096); err != nil {
		t.Fatal(err)
	}
	b.almacen.InvalidarUsado()

	res := b.pedir(t, "GET", "/api/zip?ids="+entero+","+corto, "1.2.3.4", nil)
	cuerpo, _ := io.ReadAll(res.Body)
	res.Body.Close()
	b.asentar(t)

	// El truncado no puede ir dentro, y sobre todo no puede gastar su descarga.
	if c := b.contador(t, corto); c != 0 {
		t.Errorf("el fichero truncado gastó una descarga: %d", c)
	}
	if res.StatusCode == http.StatusOK {
		archivo, err := zip.NewReader(bytes.NewReader(cuerpo), int64(len(cuerpo)))
		if err != nil {
			t.Fatalf("el archivo no abre: %v", err)
		}
		for _, f := range archivo.File {
			r, err := f.Open()
			if err != nil {
				t.Fatal(err)
			}
			datos, err := io.ReadAll(r)
			r.Close()
			if err != nil {
				t.Fatal(err)
			}
			if int64(len(datos)) != int64(f.UncompressedSize64) {
				t.Errorf("%q dice %d bytes y trae %d", f.Name, f.UncompressedSize64, len(datos))
			}
			if len(datos) == 4096 {
				t.Errorf("el fichero truncado ha salido en el archivo")
			}
		}
	}
	// Y el que estaba bien sí puede haber salido; si salió, cuenta.
	if res.StatusCode == http.StatusOK {
		if c := b.contador(t, entero); c != 1 {
			t.Errorf("el fichero íntegro debería contar una descarga: %d", c)
		}
	}
}

// Y si se trunca DESPUÉS de empezar a mandarlo, el archivo no puede cerrarse
// como si estuviera completo: quien lo reciba tiene que ver un archivo roto, no
// un fichero corto con pinta de entero.
func TestZipNoCierraUnArchivoQueSeQuedoCorto(t *testing.T) {
	b := nuevoBanco(t)
	id := b.fichero(t, 1<<20, 0)

	// Se le quita la mitad justo antes de pedirlo, pero la ficha ya está en
	// memoria del reclamo con el tamaño viejo.
	ruta, _ := b.almacen.RutaBlob(id)
	m := b.almacen.LeerMeta(id)
	m.Size = 1 << 20
	if err := b.almacen.EscribirMeta(m); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(ruta, 1<<19); err != nil {
		t.Fatal(err)
	}
	b.almacen.InvalidarUsado()

	res := b.pedir(t, "GET", "/api/zip?ids="+id, "5.6.7.8", nil)
	cuerpo, _ := io.ReadAll(res.Body)
	res.Body.Close()
	b.asentar(t)

	if res.StatusCode == http.StatusOK && len(cuerpo) > 0 {
		if _, err := zip.NewReader(bytes.NewReader(cuerpo), int64(len(cuerpo))); err == nil {
			t.Error("el archivo se cerró como bueno con un fichero a medias dentro")
		}
	}
	if c := b.contador(t, id); c != 0 {
		t.Errorf("un archivo que no salió entero no puede contar descargas: %d", c)
	}
}
