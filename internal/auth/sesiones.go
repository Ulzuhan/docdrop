package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Las sesiones, encima de identidades que viven en el proveedor OIDC.
//
// La sesión es una cookie firmada (HMAC-SHA256) sin estado en el servidor, pero
// nombra a un usuario. Cambiar DOCDROP_SESSION_SECRET sigue revocándolas todas
// de golpe. La baja de una cuenta en el proveedor surte efecto cuando caduca
// esta cookie corta; no hay introspección OIDC por petición.
//
// El formato de la cookie NO cambia con el port: con el mismo secreto, una
// sesión abierta contra Node sigue valiendo contra Go y al revés. Es parte de
// lo que hace que la vuelta atrás no eche a nadie.
//
//	docdrop_session = base64url(JSON{uid,iat,exp}) "." base64url(HMAC-SHA256)

const CookieSesion = "docdrop_session"

type Sesiones struct {
	secreto []byte
	ttl     time.Duration
	seguras bool
	rev     *Revocaciones
	ahora   func() time.Time
}

// NuevasSesiones. Sin secreto de al menos 32 bytes no se puede firmar nada y la
// aplicación no deja entrar a nadie: no hay modo abierto al que caer, porque un
// endpoint de subida al alcance de cualquiera es alojamiento anónimo gratis.
func NuevasSesiones(secreto string, ttlHoras int, seguras bool, rev *Revocaciones, ahora func() time.Time) *Sesiones {
	if ahora == nil {
		ahora = time.Now
	}
	s := &Sesiones{seguras: seguras, rev: rev, ahora: ahora}
	if len(secreto) >= 32 {
		s.secreto = []byte(secreto)
	}
	s.ttl = time.Duration(min(24, max(1, ttlHoras))) * time.Hour
	return s
}

// TTLDeEntorno lee DOCDROP_SESSION_TTL_HOURS con el mismo acotado que Node.
func TTLDeEntorno() int {
	v, err := strconv.Atoi(strings.TrimSpace(os.Getenv("DOCDROP_SESSION_TTL_HOURS")))
	if err != nil {
		return 12
	}
	return min(24, max(1, v))
}

func (s *Sesiones) Configurado() bool { return len(s.secreto) > 0 }

func (s *Sesiones) firmar(carga string) string {
	m := hmac.New(sha256.New, s.secreto)
	m.Write([]byte(carga))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

type cargaSesion struct {
	UID string `json:"uid"`
	IAT int64  `json:"iat"`
	Exp int64  `json:"exp"`
}

// Crear acuña la cookie de una persona. `iat` es lo que permite revocar sin
// guardar sesiones: la lista de revocación dice desde cuándo dejó de valer lo
// de alguien, y sin saber cuándo se emitió esta cookie no se puede comparar.
func (s *Sesiones) Crear(uid string) string {
	if !s.Configurado() {
		return ""
	}
	ahora := s.ahora()
	datos, err := json.Marshal(cargaSesion{UID: uid, IAT: ahora.UnixMilli(), Exp: ahora.Add(s.ttl).UnixMilli()})
	if err != nil {
		return ""
	}
	carga := base64.RawURLEncoding.EncodeToString(datos)
	return carga + "." + s.firmar(carga)
}

// UsuarioDe devuelve el id dentro de una cookie, o "" si es falsa, vieja,
// malformada o revocada.
func (s *Sesiones) UsuarioDe(token string) string {
	if !s.Configurado() || token == "" {
		return ""
	}
	punto := strings.LastIndex(token, ".")
	if punto <= 0 {
		return ""
	}
	carga, dada := token[:punto], token[punto+1:]
	esperada := s.firmar(carga)
	if len(dada) != len(esperada) || !hmac.Equal([]byte(dada), []byte(esperada)) {
		return ""
	}
	datos, err := base64.RawURLEncoding.DecodeString(carga)
	if err != nil {
		return ""
	}
	var c cargaSesion
	if json.Unmarshal(datos, &c) != nil {
		return ""
	}
	ahora := s.ahora().UnixMilli()
	if c.Exp == 0 || c.Exp <= ahora || c.UID == "" {
		return ""
	}
	// Las cookies emitidas antes de que existiera `iat` se fechan por su
	// caducidad: se emitieron una vida de sesión antes. Es exacto mientras el
	// tope no cambie, y en el peor caso revoca de más, que es el lado bueno por
	// el que equivocarse.
	emitida := c.IAT
	if emitida == 0 {
		emitida = c.Exp - s.ttl.Milliseconds()
	}
	if s.rev != nil && s.rev.RevocadaDespuesDe(c.UID, emitida) {
		return ""
	}
	return c.UID
}

// Cookie arma la cookie de sesión con las mismas opciones que Node.
//
// `Secure` va puesto salvo que se pida lo contrario explícitamente
// (DOCDROP_INSECURE_COOKIES=1, para desarrollo por HTTP). Node lo ataba a
// NODE_ENV, que en un binario no existe: una variable de entorno de Node no
// puede decidir si una cookie de sesión viaja en claro.
func (s *Sesiones) Cookie(valor string) *http.Cookie {
	c := &http.Cookie{
		Name:     CookieSesion,
		Value:    valor,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.seguras,
		// "strict" no sobreviviría a la vuelta desde el proveedor: el navegador la
		// trata como navegación entre sitios y no mandaría la cookie.
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(s.ttl.Seconds()),
	}
	return c
}

// CookieBorrada es la que caduca la sesión en el navegador.
func (s *Sesiones) CookieBorrada() *http.Cookie {
	c := s.Cookie("")
	c.MaxAge = -1
	return c
}

// CookieTemporal es la del inicio de sesión (verificador PKCE, state y destino),
// que dura diez minutos y no es la sesión.
func (s *Sesiones) CookieTemporal(nombre, valor string, vida time.Duration) *http.Cookie {
	return &http.Cookie{
		Name:     nombre,
		Value:    valor,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.seguras,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(vida.Seconds()),
	}
}
