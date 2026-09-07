package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/Ulzuhan/docdrop/internal/auth"
)

// cuenta siembra una persona y devuelve su cookie firmada.
func (b *banco) cuenta(t *testing.T, sub string) string {
	t.Helper()
	nombre := sub
	u, err := b.cuentas.Registrar(auth.Identidad{Sub: sub, Email: sub + "@example.invalid", Name: &nombre})
	if err != nil {
		t.Fatal(err)
	}
	return auth.CookieSesion + "=" + b.sesiones.Crear(u.ID)
}

func (b *banco) enlaceInvitado(t *testing.T, emisor string) string {
	t.Helper()
	e, err := b.invitados.Crear(float64(24), "Prueba", emisor)
	if err != nil {
		t.Fatal(err)
	}
	return e.Token
}

func (b *banco) json(t *testing.T, metodo, ruta string, cabeceras map[string]string, cuerpo any) (int, map[string]any) {
	t.Helper()
	var lector io.Reader
	if cuerpo != nil {
		datos, err := json.Marshal(cuerpo)
		if err != nil {
			t.Fatal(err)
		}
		lector = bytes.NewReader(datos)
	}
	r, err := http.NewRequest(metodo, b.http.URL+ruta, lector)
	if err != nil {
		t.Fatal(err)
	}
	if cuerpo != nil {
		r.Header.Set("content-type", "application/json")
	}
	for k, v := range cabeceras {
		r.Header.Set(k, v)
	}
	res, err := b.http.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var v map[string]any
	_ = json.NewDecoder(res.Body).Decode(&v)
	b.asentar(t)
	return res.StatusCode, v
}

// Quien tiene sesión Y abre un enlace de invitado puede terminar la subida que
// empezó por ese enlace.
//
// En 2.3.1 no podía: la subida se abría como `guest:<token>` —ahí ganaba el
// invitado— y cada trozo se identificaba como `user:<id>` —ahí ganaba la
// sesión—, así que no coincidían nunca y la subida moría con 404. Le pasa a
// cualquiera con cuenta que reciba un enlace, y al operador probando el suyo.
func TestSesionYEnlaceDeInvitadoALaVez(t *testing.T) {
	b := nuevoBanco(t)
	galleta := b.cuenta(t, "ana")
	token := b.enlaceInvitado(t, "otra-persona")
	cabeceras := map[string]string{"cookie": galleta, auth.CabeceraInvitado: token}

	estado, cuerpo := b.json(t, "POST", "/api/upload/init", cabeceras,
		map[string]any{"filename": "de-fuera.bin", "size": 2048, "ttlHours": 24})
	if estado != http.StatusOK {
		t.Fatalf("init dio %d", estado)
	}
	id, _ := cuerpo["uploadId"].(string)
	if id == "" {
		t.Fatalf("sin uploadId: %v", cuerpo)
	}

	// El trozo, con las dos credenciales puestas, como las manda el navegador.
	parte, err := http.NewRequest("PUT", b.http.URL+"/api/upload/"+id+"/part/0", bytes.NewReader(make([]byte, 2048)))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range cabeceras {
		parte.Header.Set(k, v)
	}
	res, err := b.http.Client().Do(parte)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	b.asentar(t)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("el trozo dio %d; en 2.3.1 daba 404 y la subida moría ahí", res.StatusCode)
	}

	if estado, _ := b.json(t, "GET", "/api/upload/"+id, cabeceras, nil); estado != http.StatusOK {
		t.Fatalf("el estado de la subida dio %d", estado)
	}
	estado, cerrada := b.json(t, "POST", "/api/upload/"+id+"/complete", cabeceras, map[string]any{})
	if estado != http.StatusOK {
		t.Fatalf("cerrar dio %d: %v", estado, cerrada)
	}
	// Y el fichero es de quien emitió el enlace, no de quien lo subió.
	m := b.almacen.LeerMeta(id)
	if m == nil || m.Owner != "user:otra-persona" {
		t.Fatalf("el dueño debería ser el emisor del enlace: %+v", m)
	}
}

// Lo que esa comprobación protege sigue protegido: con DOS enlaces de invitado
// distintos, el segundo no toca la subida del primero.
func TestUnInvitadoNoTocaLaSubidaDeOtro(t *testing.T) {
	b := nuevoBanco(t)
	uno := b.enlaceInvitado(t, "emisor")
	otro := b.enlaceInvitado(t, "emisor")

	estado, cuerpo := b.json(t, "POST", "/api/upload/init",
		map[string]string{auth.CabeceraInvitado: uno},
		map[string]any{"filename": "suyo.bin", "size": 1024})
	if estado != http.StatusOK {
		t.Fatalf("init dio %d", estado)
	}
	id := cuerpo["uploadId"].(string)

	ajeno := map[string]string{auth.CabeceraInvitado: otro}
	// Mismo 404 que si no existiera: quien no es de aquí no tiene por qué
	// enterarse de que hay algo.
	for _, caso := range []struct {
		metodo, ruta string
	}{
		{"GET", "/api/upload/" + id},
		{"DELETE", "/api/upload/" + id},
		{"POST", "/api/upload/" + id + "/complete"},
	} {
		if estado, _ := b.json(t, caso.metodo, caso.ruta, ajeno, nil); estado != http.StatusNotFound {
			t.Errorf("%s %s dio %d, esperaba 404", caso.metodo, caso.ruta, estado)
		}
	}
	parte, _ := http.NewRequest("PUT", b.http.URL+"/api/upload/"+id+"/part/0", bytes.NewReader(make([]byte, 1024)))
	parte.Header.Set(auth.CabeceraInvitado, otro)
	res, err := b.http.Client().Do(parte)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	b.asentar(t)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("escribir el trozo de otro dio %d, esperaba 404", res.StatusCode)
	}
	// Y la subida del primero sigue intacta y sin trozos.
	if partes := len(b.almacen.ListarMeta()); partes != 0 {
		t.Fatalf("no debería haber ficheros terminados: %d", partes)
	}
}
