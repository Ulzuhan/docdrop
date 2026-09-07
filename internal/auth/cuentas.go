package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Las personas que pueden usar esta instancia.
//
// Las cuentas viven en Authentik; lo que se guarda aquí es un espejo de la
// identidad, para que un fichero pueda decir quién lo subió y una sesión pueda
// apuntar a alguien. Aquí no hay contraseñas y no hay alta: las dos son del
// proveedor, que sólo emite tokens para quien esté en el grupo de esta
// aplicación.
//
// Un fichero JSON por persona bajo <DATA>/users/. "users" no casa con el
// formato de id, así que los recorridos del almacén se saltan el directorio sin
// saber que existe.

type Usuario struct {
	ID string `json:"id"`
	// El `sub` del proveedor: estable aunque cambie el correo.
	OidcSub    string `json:"oidcSub"`
	Email      string `json:"email"`
	Name       string `json:"name,omitempty"`
	CreatedAt  int64  `json:"createdAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
}

// NombreVisible es con qué etiquetar lo que sube esta persona.
func (u *Usuario) NombreVisible() string {
	if n := strings.TrimSpace(u.Name); n != "" {
		return n
	}
	return strings.Split(u.Email, "@")[0]
}

type Cuentas struct {
	dir   string
	ahora func() time.Time
}

func NuevasCuentas(base string, ahora func() time.Time) *Cuentas {
	if ahora == nil {
		ahora = time.Now
	}
	return &Cuentas{dir: filepath.Join(base, "users"), ahora: ahora}
}

// El nombre del fichero sale del sub, con hash: un sub es opaco pero no tiene
// por qué ser seguro como parte de una ruta, y el hash esquiva la pregunta.
func (c *Cuentas) ruta(sub string) string {
	suma := sha256.Sum256([]byte(sub))
	return filepath.Join(c.dir, hex.EncodeToString(suma[:])+".json")
}

func (c *Cuentas) PorSub(sub string) *Usuario {
	datos, err := os.ReadFile(c.ruta(sub))
	if err != nil {
		return nil
	}
	var u Usuario
	if json.Unmarshal(datos, &u) != nil {
		return nil
	}
	return &u
}

// PorID recorre el directorio. Es O(n) y a esta escala está bien: meter un
// índice nuevo sería un formato que la vuelta atrás a Node no sabría leer.
func (c *Cuentas) PorID(id string) *Usuario {
	if id == "" {
		return nil
	}
	entradas, err := os.ReadDir(c.dir)
	if err != nil {
		return nil
	}
	for _, e := range entradas {
		datos, err := os.ReadFile(filepath.Join(c.dir, e.Name()))
		if err != nil {
			continue // un fichero ilegible no debe tumbar la búsqueda
		}
		var u Usuario
		if json.Unmarshal(datos, &u) != nil {
			continue
		}
		if u.ID == id {
			return &u
		}
	}
	return nil
}

// Registrar es la persona detrás de una identidad, creada la primera vez que
// llega y actualizada las siguientes.
func (c *Cuentas) Registrar(id Identidad) (*Usuario, error) {
	ahora := c.ahora().UnixMilli()
	u := c.PorSub(id.Sub)
	if u == nil {
		nuevo, err := uuid()
		if err != nil {
			return nil, err
		}
		u = &Usuario{ID: nuevo, OidcSub: id.Sub, CreatedAt: ahora}
	}
	u.Email = id.Email
	// Se reescribe siempre, también cuando el proveedor deja de mandarlo: es lo
	// que hace la versión de Node, y así el espejo no conserva un nombre viejo.
	u.Name = ""
	if id.Name != nil {
		u.Name = *id.Name
	}
	u.LastSeenAt = ahora

	if err := os.MkdirAll(c.dir, 0o750); err != nil {
		return nil, err
	}
	datos, err := json.MarshalIndent(u, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(c.ruta(u.OidcSub), datos, 0o640); err != nil {
		return nil, err
	}
	return u, nil
}

// uuid genera un UUID v4, que es lo que usa `randomUUID()` en Node.
func uuid() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
