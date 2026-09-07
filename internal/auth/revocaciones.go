package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// La lista de revocación: quién dejó de tener acceso, y desde cuándo.
//
// POR QUÉ EXISTE. La sesión de esta aplicación es una cookie firmada sin nada
// en el servidor, y eso tiene una consecuencia incómoda: cuando el proveedor
// avisa de que alguien ha dejado de tener acceso, no hay ninguna sesión que
// borrar. La cookie ya está en su navegador y sigue siendo válida hasta que
// caduque sola.
//
// La respuesta estándar no es guardar sesiones —volveríamos a tener estado por
// cada visita— sino guardar lo contrario: una marca por persona que dice «lo
// emitido antes de este instante ya no vale». Es una línea por revocación, se
// borra sola, y deja intacto el diseño sin estado para todo el mundo que no ha
// sido revocado.
//
// LO QUE GUARDA, y conviene que sea poco: un identificador opaco y una fecha.
// Ni correo, ni nombre, ni nada de lo que la persona haya subido.

// Cuánto se conserva una marca: pasada la vida máxima de una sesión ya no puede
// impedir nada, porque la cookie a la que se refería habría caducado igual.
const vidaRevocacion = 25 * time.Hour

type Revocaciones struct {
	ruta  string
	ahora func() time.Time

	mu      sync.Mutex
	memoria map[string]int64
	cargado bool
}

func NuevasRevocaciones(base string, ahora func() time.Time) *Revocaciones {
	if ahora == nil {
		ahora = time.Now
	}
	return &Revocaciones{ruta: filepath.Join(base, "revocaciones.json"), ahora: ahora}
}

// cargar se llama con el candado puesto.
func (r *Revocaciones) cargar() {
	if r.cargado {
		return
	}
	r.cargado = true
	r.memoria = map[string]int64{}
	datos, err := os.ReadFile(r.ruta)
	if err != nil {
		// Sin fichero todavía, o ilegible: se empieza vacío. No poder LEER la
		// lista no debe tumbar la aplicación; lo que no puede fallar en silencio
		// es escribirla, y de eso se encarga Revocar.
		return
	}
	var crudo map[string]int64
	if json.Unmarshal(datos, &crudo) != nil {
		return
	}
	r.memoria = crudo
	r.podar()
}

// podar se llama con el candado puesto.
func (r *Revocaciones) podar() {
	limite := r.ahora().Add(-vidaRevocacion).UnixMilli()
	for k, v := range r.memoria {
		if v < limite {
			delete(r.memoria, k)
		}
	}
}

// Revocar marca que todo lo emitido para esta persona hasta ahora deja de valer.
//
// Devuelve error si no puede escribir: quien llama —el aviso del proveedor—
// tiene que poder responder que no se ha atendido, para que lo reintente. Una
// revocación que se pierde en silencio es peor que no tener revocación.
func (r *Revocaciones) Revocar(identificador string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cargar()
	r.podar()
	r.memoria[identificador] = r.ahora().UnixMilli()

	if err := os.MkdirAll(filepath.Dir(r.ruta), 0o750); err != nil {
		return err
	}
	datos, err := json.Marshal(r.memoria)
	if err != nil {
		return err
	}
	// Escritura atómica: un fichero a medias por un corte dejaría la lista
	// ilegible, y una lista ilegible se lee como «no hay revocaciones».
	tmp := fmt.Sprintf("%s.%d.tmp", r.ruta, os.Getpid())
	if err := os.WriteFile(tmp, datos, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, r.ruta); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// RevocadaDespuesDe dice si esta persona estaba revocada cuando se emitió esa
// sesión.
func (r *Revocaciones) RevocadaDespuesDe(identificador string, emitidaEn int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cargar()
	cuando, hay := r.memoria[identificador]
	return hay && emitidaEn <= cuando
}

// Olvidar vuelve a leer del disco. Sólo para las pruebas.
func (r *Revocaciones) Olvidar() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cargado = false
	r.memoria = nil
}
