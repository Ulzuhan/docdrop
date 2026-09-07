package httpapi

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
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
