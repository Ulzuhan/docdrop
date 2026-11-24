package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// Opt-in group gate for OAuth JWT access tokens (ES256 JWKS) that bind
// client_id to the grant and embed a server-assigned groups claim.
func (d *Discovery) requireMembership(ctx context.Context, cfg *Config, e *Endpoints, token, expectedSub string) error {
	denied := errors.New("OIDC required membership could not be verified")
	p := strings.Split(token, ".")
	if len(p) != 3 || len(token) > 32768 || e.JWKS == "" || expectedSub == "" {
		return denied
	}
	dec := base64.RawURLEncoding.DecodeString
	h, err := dec(p[0])
	if err != nil {
		return denied
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if json.Unmarshal(h, &hdr) != nil || hdr.Alg != "ES256" || hdr.Kid == "" {
		return denied
	}
	body, err := dec(p[1])
	if err != nil {
		return denied
	}
	var claims struct {
		Iss    string   `json:"iss"`
		Sub    string   `json:"sub"`
		Client string   `json:"client_id"`
		Aud    any      `json:"aud"`
		Groups []string `json:"groups"`
		Exp    int64    `json:"exp"`
		Nbf    int64    `json:"nbf"`
	}
	now := time.Now().Unix()
	if json.Unmarshal(body, &claims) != nil || claims.Iss != cfg.Issuer || claims.Sub != expectedSub || claims.Client != cfg.ClientID ||
		!audienciaContiene(claims.Aud, "authenticated") || claims.Exp <= now || claims.Nbf > now || !contiene(claims.Groups, cfg.RequiredGroup) {
		return denied
	}
	sig, err := dec(p[2])
	if err != nil || len(sig) != 64 {
		return denied
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.JWKS, nil)
	if err != nil {
		return denied
	}
	res, err := d.client.Do(req)
	if err != nil {
		return denied
	}
	defer res.Body.Close()
	var ks struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			Alg string `json:"alg"`
			Crv string `json:"crv"`
			Use string `json:"use"`
			X   string `json:"x"`
			Y   string `json:"y"`
		} `json:"keys"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&ks) != nil {
		return denied
	}
	sum := sha256.Sum256([]byte(p[0] + "." + p[1]))
	curve := elliptic.P256()
	for _, k := range ks.Keys {
		if k.Kid != hdr.Kid || k.Kty != "EC" || k.Alg != "ES256" || k.Crv != "P-256" || k.Use != "sig" {
			continue
		}
		x, xe := dec(k.X)
		y, ye := dec(k.Y)
		if xe != nil || ye != nil || len(x) != 32 || len(y) != 32 {
			continue
		}
		key := ecdsa.PublicKey{Curve: curve, X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
		if curve.IsOnCurve(key.X, key.Y) && ecdsa.Verify(&key, sum[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
			return nil
		}
	}
	return denied
}
