package auth

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Aviso es un cierre de sesión verificado del proveedor.
type Aviso struct {
	Sub string
	JTI string
}

// Tres errores distintos porque tres respuestas distintas: un token inválido es
// culpa de quien llama (400), no poder verificar es nuestro (503), y un aviso
// que no soportamos hay que decirlo (400) y no fingir que se aplicó.
var (
	ErrAvisoInvalido    = errors.New("logout_token inválido")
	ErrNoVerificable    = errors.New("no se pudo verificar")
	ErrSoloSid          = errors.New("aviso con sid y sin sub: no soportado")
	ErrAvisoRepetido    = errors.New("jti ya visto")
	eventoBackchannel   = "http://schemas.openid.net/event/backchannel-logout"
	margenReloj         = 2 * time.Minute
	antiguedadMaximaIat = 5 * time.Minute
)

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// Verificador guarda las claves del proveedor y los JTI ya aplicados.
//
// Los JTI viven en memoria a propósito, y hay que decirlo en vez de prometer
// otra cosa: **un reinicio los olvida**. Con las sesiones ya borradas, repetir
// un aviso no reabre nada; lo que se pierde es la detección del repetido, no la
// revocación.
type Verificador struct {
	mu     sync.Mutex
	claves []jwk
	cuando time.Time
	vistos map[string]time.Time
	client *http.Client
	Ahora  func() time.Time
}

func NuevoVerificador() *Verificador {
	return &Verificador{vistos: map[string]time.Time{}, client: &http.Client{Timeout: 30 * time.Second}, Ahora: time.Now}
}

const ttlJwks = 10 * time.Minute

func (v *Verificador) jwks(ctx context.Context, url string, espera time.Duration) ([]jwk, error) {
	v.mu.Lock()
	if v.claves != nil && time.Since(v.cuando) < ttlJwks {
		c := v.claves
		v.mu.Unlock()
		return c, nil
	}
	v.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, espera)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := v.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, errors.New("jwks no disponible")
	}
	var doc struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&doc); err != nil {
		return nil, err
	}
	v.mu.Lock()
	v.claves, v.cuando = doc.Keys, time.Now()
	v.mu.Unlock()
	return doc.Keys, nil
}

// YaVisto consulta y NO marca. Marcar se hace aparte y sólo cuando la
// revocación ya se ha aplicado: marcarlo antes convierte un fallo de base de
// datos en una revocación perdida para siempre, porque el reintento del
// proveedor se descarta como repetido.
func (v *Verificador) YaVisto(jti string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	ahora := v.Ahora()
	for k, t := range v.vistos {
		if ahora.Sub(t) > time.Hour {
			delete(v.vistos, k)
		}
	}
	_, hay := v.vistos[jti]
	return hay
}

// Anotar marca el JTI como aplicado. Se llama DESPUÉS de revocar.
func (v *Verificador) Anotar(jti string) {
	v.mu.Lock()
	v.vistos[jti] = v.Ahora()
	v.mu.Unlock()
}

func trozoJSON(parte string) (map[string]any, error) {
	crudo, err := base64.RawURLEncoding.DecodeString(parte)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(crudo, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// Verificar comprueba firma, emisor, audiencia, tipo de evento y tiempos.
//
// Frente a 0.5.0 cambian tres cosas, todas hacia el lado seguro:
//   - `exp` es OBLIGATORIO y finito. Antes sólo se validaba si venía y era
//     numérico, así que un token sin `exp` pasaba.
//   - un aviso con `sid` y sin `sub` se RECHAZA en vez de responder 200 sin
//     hacer nada. Estas sesiones no guardan el `sid` del proveedor, así que no
//     hay forma de aplicarlo; decir que sí sería mentir al proveedor, que deja
//     de reintentar.
//   - el JTI se marca fuera de aquí, después de revocar.
func (v *Verificador) Verificar(ctx context.Context, token string, cfg *Config, e *Endpoints) (Aviso, error) {
	partes := strings.Split(token, ".")
	if len(partes) != 3 || e == nil || e.JWKS == "" {
		if e == nil || e.JWKS == "" {
			return Aviso{}, ErrNoVerificable
		}
		return Aviso{}, ErrAvisoInvalido
	}
	cabecera, err := trozoJSON(partes[0])
	if err != nil {
		return Aviso{}, ErrAvisoInvalido
	}
	if alg, _ := cabecera["alg"].(string); alg != "RS256" {
		return Aviso{}, ErrAvisoInvalido
	}
	// `typ`, si viene, tiene que ser el de un aviso de cierre. Lo comprueba
	// también la versión de Node y no hay motivo para relajarlo aquí.
	if typ, hay := cabecera["typ"]; hay {
		if s, _ := typ.(string); s != "logout+jwt" && s != "JWT" {
			return Aviso{}, ErrAvisoInvalido
		}
	}
	carga, err := trozoJSON(partes[1])
	if err != nil {
		return Aviso{}, ErrAvisoInvalido
	}
	firma, err := base64.RawURLEncoding.DecodeString(partes[2])
	if err != nil {
		return Aviso{}, ErrAvisoInvalido
	}

	claves, err := v.jwks(ctx, e.JWKS, cfg.Timeout)
	if err != nil {
		return Aviso{}, ErrNoVerificable
	}
	kid, _ := cabecera["kid"].(string)
	firmado := []byte(partes[0] + "." + partes[1])
	suma := sha256.Sum256(firmado)
	valida := false
	for _, k := range claves {
		if k.Kty != "RSA" || (kid != "" && k.Kid != "" && k.Kid != kid) {
			continue
		}
		pub, err := rsaDesdeJWK(k)
		if err != nil {
			continue
		}
		if rsa.VerifyPKCS1v15(pub, crypto.SHA256, suma[:], firma) == nil {
			valida = true
			break
		}
	}
	if !valida {
		return Aviso{}, ErrAvisoInvalido
	}

	emisor, _ := carga["iss"].(string)
	if !contiene(e.Emisores, emisor) {
		return Aviso{}, ErrAvisoInvalido
	}
	if !audienciaContiene(carga["aud"], cfg.ClientID) {
		return Aviso{}, ErrAvisoInvalido
	}
	// El evento tiene que ser el de cierre: sin esto, cualquier token firmado
	// por el proveedor para otra cosa cerraría sesiones.
	eventos, _ := carga["events"].(map[string]any)
	if _, hay := eventos[eventoBackchannel]; !hay {
		return Aviso{}, ErrAvisoInvalido
	}
	// Un logout_token con `nonce` no es un logout_token (spec §2.4).
	if _, hay := carga["nonce"]; hay {
		return Aviso{}, ErrAvisoInvalido
	}

	ahora := v.Ahora()
	exp, ok := numero(carga["exp"])
	if !ok || time.Unix(int64(exp), 0).Add(margenReloj).Before(ahora) {
		return Aviso{}, ErrAvisoInvalido
	}
	iat, ok := numero(carga["iat"])
	if !ok {
		return Aviso{}, ErrAvisoInvalido
	}
	emitido := time.Unix(int64(iat), 0)
	if emitido.After(ahora.Add(margenReloj)) || ahora.Sub(emitido) > antiguedadMaximaIat {
		return Aviso{}, ErrAvisoInvalido
	}
	jti, _ := carga["jti"].(string)
	if jti == "" {
		return Aviso{}, ErrAvisoInvalido
	}

	sub, _ := carga["sub"].(string)
	sid, _ := carga["sid"].(string)
	if sub == "" {
		if sid != "" {
			return Aviso{}, ErrSoloSid
		}
		return Aviso{}, ErrAvisoInvalido
	}
	if v.YaVisto(jti) {
		return Aviso{}, ErrAvisoRepetido
	}
	return Aviso{Sub: sub, JTI: jti}, nil
}

func rsaDesdeJWK(k jwk) (*rsa.PublicKey, error) {
	n, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, err
	}
	e, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, err
	}
	if len(e) > 8 {
		return nil, errors.New("exponente absurdo")
	}
	relleno := make([]byte, 8)
	copy(relleno[8-len(e):], e)
	return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(binary.BigEndian.Uint64(relleno))}, nil
}

func contiene(lista []string, v string) bool {
	for _, x := range lista {
		if x == v {
			return true
		}
	}
	return false
}

func audienciaContiene(aud any, clientID string) bool {
	switch v := aud.(type) {
	case string:
		return v == clientID
	case []any:
		for _, x := range v {
			if s, ok := x.(string); ok && s == clientID {
				return true
			}
		}
	}
	return false
}

func numero(v any) (float64, bool) {
	// Sólo números JSON. Una cadena "9999999999" no es una fecha válida aquí, y
	// aceptarla dejaría pasar tokens con `exp` de mentira.
	f, ok := v.(float64)
	if !ok {
		return 0, false
	}
	// NaN e infinitos no son instantes.
	if f != f || f > 1e15 || f < 0 {
		return 0, false
	}
	return f, true
}
