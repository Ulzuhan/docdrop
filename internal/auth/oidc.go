// Package auth implementa el flujo de código con PKCE y el aviso de cierre de
// sesión del proveedor.
//
// También lleva las sesiones de DocDrop, que son una cookie firmada sin estado
// en el servidor (ver sesiones.go), el espejo local de las cuentas, la lista de
// revocación y los enlaces de invitado.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Issuer         string
	PublicOrigin   string
	InternalOrigin string
	ClientID       string
	ClientSecret   string
	RedirectURI    string
	Timeout        time.Duration
}

// urlValida acepta https siempre y http sólo en loopback, salvo que se permita
// explícitamente. La pata interna sí admite http con cualquier nombre: es el
// tramo servidor→proveedor y un alias de red de contenedores es lo normal.
func urlValida(crudo string, permitirHTTP bool) string {
	crudo = strings.TrimSpace(crudo)
	if crudo == "" {
		return ""
	}
	u, err := url.Parse(crudo)
	if err != nil || u.Host == "" {
		return ""
	}
	loopback := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"
	if u.Scheme != "https" && !((permitirHTTP || loopback) && u.Scheme == "http") {
		return ""
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	return strings.TrimRight(u.String(), "/")
}

func DesdeEntorno() *Config {
	clientID := strings.TrimSpace(os.Getenv("DOCDROP_OIDC_CLIENT_ID"))
	secreto := strings.TrimSpace(os.Getenv("DOCDROP_OIDC_CLIENT_SECRET"))
	emisor := urlValida(os.Getenv("DOCDROP_OIDC_ISSUER"), false)
	if emisor == "" || clientID == "" || secreto == "" {
		return nil
	}
	publico, err := url.Parse(emisor)
	if err != nil {
		return nil
	}
	interno := urlValida(os.Getenv("DOCDROP_OIDC_INTERNAL_BASE"), true)
	if interno == "" {
		interno = publico.Scheme + "://" + publico.Host
	}
	redirect := urlValida(os.Getenv("DOCDROP_OIDC_REDIRECT_URI"), false)
	if redirect == "" {
		return nil
	}
	espera := 10 * time.Second
	if v, err := strconv.Atoi(os.Getenv("DOCDROP_OIDC_TIMEOUT_MS")); err == nil && v >= 1000 && v <= 60000 {
		espera = time.Duration(v) * time.Millisecond
	}
	return &Config{Issuer: emisor, PublicOrigin: publico.Scheme + "://" + publico.Host,
		InternalOrigin: interno, ClientID: clientID, ClientSecret: secreto,
		RedirectURI: redirect, Timeout: espera}
}

type Endpoints struct {
	Authorization string
	Token         string
	UserInfo      string
	EndSession    string
	JWKS          string
	// Emisores aceptados: el anunciado, más el mismo visto por la pata pública
	// y por la interna. Son la misma instalación con dos direcciones.
	Emisores []string
}

// Discovery cachea el documento del proveedor. Si una recarga falla se sigue
// usando el anterior: una caída momentánea del proveedor no debe tumbar el
// login de quien ya tiene sesión.
type Discovery struct {
	mu     sync.Mutex
	clave  string
	cuando time.Time
	valor  *Endpoints
	client *http.Client
}

func NuevoDiscovery() *Discovery {
	return &Discovery{client: &http.Client{Timeout: 30 * time.Second}}
}

const ttlDiscovery = 10 * time.Minute

// en reapunta un endpoint del proveedor a la dirección que su llamante puede
// alcanzar. Las rutas son del proveedor; las direcciones, nuestras.
func en(endpoint, origen string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return endpoint
	}
	o, err := url.Parse(origen)
	if err != nil {
		return endpoint
	}
	u.Scheme, u.Host = o.Scheme, o.Host
	return u.String()
}

func (d *Discovery) Endpoints(ctx context.Context, cfg *Config) (*Endpoints, error) {
	clave := cfg.Issuer + "|" + cfg.InternalOrigin
	d.mu.Lock()
	if d.valor != nil && d.clave == clave && time.Since(d.cuando) < ttlDiscovery {
		v := d.valor
		d.mu.Unlock()
		return v, nil
	}
	anterior := d.valor
	mismaClave := d.clave == clave
	d.mu.Unlock()

	destino := strings.TrimRight(en(cfg.Issuer, cfg.InternalOrigin), "/") + "/.well-known/openid-configuration"
	ctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, destino, nil)
	if err != nil {
		return nil, err
	}
	res, err := d.client.Do(req)
	if err != nil || res.StatusCode != http.StatusOK {
		if res != nil {
			res.Body.Close()
		}
		if anterior != nil && mismaClave {
			return anterior, nil
		}
		if err == nil {
			err = fmt.Errorf("discovery: %d", res.StatusCode)
		}
		return nil, err
	}
	defer res.Body.Close()
	var doc map[string]any
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&doc); err != nil {
		if anterior != nil && mismaClave {
			return anterior, nil
		}
		return nil, err
	}
	texto := func(k string) string {
		v, _ := doc[k].(string)
		return v
	}
	if texto("authorization_endpoint") == "" || texto("token_endpoint") == "" || texto("userinfo_endpoint") == "" {
		return nil, fmt.Errorf("discovery: al documento le faltan endpoints")
	}
	anunciado := texto("issuer")
	if anunciado == "" {
		anunciado = cfg.Issuer
	}
	e := &Endpoints{
		Authorization: en(texto("authorization_endpoint"), cfg.PublicOrigin),
		Token:         en(texto("token_endpoint"), cfg.InternalOrigin),
		UserInfo:      en(texto("userinfo_endpoint"), cfg.InternalOrigin),
		Emisores:      unicos(anunciado, en(anunciado, cfg.PublicOrigin), en(anunciado, cfg.InternalOrigin)),
	}
	if v := texto("end_session_endpoint"); v != "" {
		e.EndSession = en(v, cfg.PublicOrigin)
	}
	if v := texto("jwks_uri"); v != "" {
		e.JWKS = en(v, cfg.InternalOrigin)
	}
	d.mu.Lock()
	d.clave, d.cuando, d.valor = clave, time.Now(), e
	d.mu.Unlock()
	return e, nil
}

func unicos(vs ...string) []string {
	visto := map[string]bool{}
	var salida []string
	for _, v := range vs {
		if v != "" && !visto[v] {
			visto[v] = true
			salida = append(salida, v)
		}
	}
	return salida
}

func Aleatorio() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func Desafio(verificador string) string {
	suma := sha256.Sum256([]byte(verificador))
	return base64.RawURLEncoding.EncodeToString(suma[:])
}

// URLAutorizacion es a dónde se manda el navegador.
func (d *Discovery) URLAutorizacion(ctx context.Context, cfg *Config, estado, desafio string) (string, error) {
	e, err := d.Endpoints(ctx, cfg)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(e.Authorization)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("client_id", cfg.ClientID)
	q.Set("redirect_uri", cfg.RedirectURI)
	q.Set("response_type", "code")
	q.Set("scope", "openid email profile")
	q.Set("state", estado)
	q.Set("code_challenge", desafio)
	q.Set("code_challenge_method", "S256")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

type Identidad struct {
	Sub   string
	Email string
	Name  *string
}

// Canjear cambia el código por la identidad. El id_token no se verifica
// criptográficamente porque llega en una llamada directa servidor a servidor,
// que es el caso en el que la propia especificación lo permite (OIDC Core
// 3.1.3.7); los datos se leen además de /userinfo.
func (d *Discovery) Canjear(ctx context.Context, cfg *Config, codigo, verificador string) (Identidad, error) {
	e, err := d.Endpoints(ctx, cfg)
	if err != nil {
		return Identidad{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {codigo},
		"redirect_uri":  {cfg.RedirectURI},
		"client_id":     {cfg.ClientID},
		"client_secret": {cfg.ClientSecret},
		"code_verifier": {verificador},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.Token, strings.NewReader(form.Encode()))
	if err != nil {
		return Identidad{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := d.client.Do(req)
	if err != nil {
		return Identidad{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Identidad{}, fmt.Errorf("token: %d", res.StatusCode)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&tok); err != nil || tok.AccessToken == "" {
		return Identidad{}, fmt.Errorf("token: respuesta sin access_token")
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, e.UserInfo, nil)
	if err != nil {
		return Identidad{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	res, err = d.client.Do(req)
	if err != nil {
		return Identidad{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Identidad{}, fmt.Errorf("userinfo: %d", res.StatusCode)
	}
	var info struct {
		Sub               string `json:"sub"`
		Email             string `json:"email"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&info); err != nil {
		return Identidad{}, err
	}
	if info.Sub == "" || info.Email == "" {
		return Identidad{}, fmt.Errorf("userinfo: sin sub o email")
	}
	id := Identidad{Sub: info.Sub, Email: info.Email}
	if nombre := info.Name; nombre != "" {
		id.Name = &nombre
	} else if info.PreferredUsername != "" {
		n := info.PreferredUsername
		id.Name = &n
	}
	return id, nil
}

// SafeNext sólo deja volver a una ruta de esta aplicación. Sin esto, `next` es
// un redirector abierto con la marca de la casa.
func SafeNext(crudo string) string {
	if crudo == "" || !strings.HasPrefix(crudo, "/") || strings.HasPrefix(crudo, "//") {
		return "/"
	}
	if strings.Contains(crudo, "\\") || strings.ContainsAny(crudo, "\r\n") {
		return "/"
	}
	return crudo
}

// URLPublicaValida acepta https, o http en loopback. Se usa para las URLs de
// alta y de cuenta, que acaban en un enlace de la interfaz: una con
// `javascript:` sería un enlace ejecutable.
//
// A diferencia de urlValida, NO recorta la barra final: la página de cuenta de
// Authentik es `/if/user/` y quitársela cambia la dirección.
func URLPublicaValida(crudo string) string {
	crudo = strings.TrimSpace(crudo)
	if crudo == "" {
		return ""
	}
	u, err := url.Parse(crudo)
	if err != nil || u.Host == "" || u.User != nil {
		return ""
	}
	loopback := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(loopback && u.Scheme == "http") {
		return ""
	}
	return u.String()
}
