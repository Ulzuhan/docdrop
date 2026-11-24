package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRequiredGroupSignedAccessToken(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/jwks" {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{"kid": "k1", "kty": "EC", "alg": "ES256", "crv": "P-256", "use": "sig", "x": enc(key.X.FillBytes(make([]byte, 32))), "y": enc(key.Y.FillBytes(make([]byte, 32)))}}})
	}))
	defer srv.Close()
	mk := func(header, claims map[string]any, corrupt bool) string {
		a, _ := json.Marshal(header)
		b, _ := json.Marshal(claims)
		body := enc(a) + "." + enc(b)
		sum := sha256.Sum256([]byte(body))
		rr, ss, e := ecdsa.Sign(rand.Reader, key, sum[:])
		if e != nil {
			t.Fatal(e)
		}
		sig := append(rr.FillBytes(make([]byte, 32)), ss.FillBytes(make([]byte, 32))...)
		if corrupt {
			sig[0] ^= 255
		}
		return body + "." + enc(sig)
	}
	cfg := &Config{Issuer: "https://issuer.invalid", ClientID: "client", RequiredGroup: "docdrop"}
	cases := []struct {
		name    string
		field   string
		value   any
		corrupt bool
		wanted  bool
	}{
		{"member", "groups", []string{"other", "docdrop"}, false, true},
		{"no-membership", "groups", []string{"other"}, false, false},
		{"missing-claim", "groups", nil, false, false},
		{"malformed-claim", "groups", "docdrop", false, false},
		{"wrong-client", "client_id", "different", false, false},
		{"wrong-issuer", "iss", "https://other.invalid", false, false},
		{"wrong-audience", "aud", "anon", false, false},
		{"subject-mismatch", "sub", "other", false, false},
		{"expired", "exp", 1, false, false},
		{"not-yet-active", "nbf", time.Now().Unix() + 600, false, false},
		{"bad-signature", "groups", []string{"docdrop"}, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := map[string]any{"iss": cfg.Issuer, "sub": "user", "client_id": "client", "aud": []string{"authenticated"}, "exp": time.Now().Unix() + 60}
			c[tc.field] = tc.value
			tok := mk(map[string]any{"alg": "ES256", "kid": "k1"}, c, tc.corrupt)
			got := NuevoDiscovery().requireMembership(context.Background(), cfg, &Endpoints{JWKS: srv.URL + "/jwks"}, tok, "user") == nil
			if got != tc.wanted {
				t.Fatal("unexpected membership decision")
			}
		})
	}
}
