package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSafeNext(t *testing.T) {
	for _, path := range []string{"/", "/panel", "/qr/abc123", "/a?x=1&y=2", "/con espacio", "/con-guion"} {
		if got := SafeNext(path); got != path {
			t.Errorf("SafeNext(%q) = %q", path, got)
		}
	}
	for _, path := range []string{"", "/\\evil.com", "/\\/evil.com", "/\\\\evil.com", "//evil.com", "///evil.com", "https://evil.com", "http://evil.com", "javascript:alert(1)", "evil.com", " //evil.com", "\t//evil.com", "\n//evil.com", "\r//evil.com", "/\t\\evil.com", "/ \\evil.com"} {
		if got := SafeNext(path); got != "/" {
			t.Errorf("unsafe redirect %q -> %q", path, got)
		}
	}
}

func TestConfigDesdeEntorno(t *testing.T) {
	t.Setenv("DOCDROP_OIDC_ISSUER", "https://idp.example/realms/qr")
	t.Setenv("DOCDROP_OIDC_CLIENT_ID", "qr")
	t.Setenv("DOCDROP_OIDC_CLIENT_SECRET", "synthetic")
	t.Setenv("DOCDROP_OIDC_REDIRECT_URI", "https://qr.example/api/auth/callback")
	t.Setenv("DOCDROP_OIDC_INTERNAL_BASE", "")
	if c := DesdeEntorno(); c == nil || c.PublicOrigin != "https://idp.example" || c.InternalOrigin != c.PublicOrigin {
		t.Fatal("unexpected default config")
	}
	t.Setenv("DOCDROP_OIDC_INTERNAL_BASE", "http://idp-internal:9000")
	if c := DesdeEntorno(); c == nil || c.InternalOrigin != "http://idp-internal:9000" {
		t.Fatal("internal origin lost")
	}
	for _, key := range []string{"DOCDROP_OIDC_ISSUER", "DOCDROP_OIDC_CLIENT_ID", "DOCDROP_OIDC_CLIENT_SECRET", "DOCDROP_OIDC_REDIRECT_URI"} {
		t.Run(key, func(t *testing.T) {
			t.Setenv(key, "")
			if DesdeEntorno() != nil {
				t.Fatal("incomplete configuration accepted")
			}
		})
	}
}

func TestDiscoveryProviderPathsAndCache(t *testing.T) {
	requests, status, incomplete := 0, http.StatusOK, false
	var internal string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/realms/qr/.well-known/openid-configuration" {
			t.Errorf("discovery path: %s", r.URL.Path)
		}
		w.WriteHeader(status)
		doc := map[string]string{"issuer": internal + "/realms/qr"}
		if !incomplete {
			for key, path := range map[string]string{"authorization_endpoint": "auth", "token_endpoint": "token", "userinfo_endpoint": "userinfo", "end_session_endpoint": "logout", "jwks_uri": "certs"} {
				doc[key] = internal + "/realms/qr/protocol/openid-connect/" + path
			}
		}
		_ = json.NewEncoder(w).Encode(doc)
	}))
	defer provider.Close()
	internal = provider.URL
	cfg := &Config{Issuer: "https://idp.example/realms/qr", PublicOrigin: "https://idp.example", InternalOrigin: internal, ClientID: "qr", RedirectURI: "https://qr.example/api/auth/callback", Timeout: time.Second}
	d := NuevoDiscovery()
	ctx := context.Background()
	e, err := d.Endpoints(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if e.Authorization != "https://idp.example/realms/qr/protocol/openid-connect/auth" || e.EndSession != "https://idp.example/realms/qr/protocol/openid-connect/logout" {
		t.Fatalf("public endpoints: %+v", e)
	}
	for _, endpoint := range []string{e.Token, e.UserInfo, e.JWKS} {
		if !strings.HasPrefix(endpoint, internal+"/realms/qr/protocol/openid-connect/") {
			t.Errorf("internal endpoint: %s", endpoint)
		}
	}
	for _, issuer := range []string{cfg.Issuer, internal + "/realms/qr"} {
		found := false
		for _, value := range e.Emisores {
			found = found || issuer == value
		}
		if !found {
			t.Errorf("missing issuer %s", issuer)
		}
	}
	raw, err := d.URLAutorizacion(ctx, cfg, "state", "challenge")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(raw)
	if u.Port() != "" || u.Query().Get("code_challenge_method") != "S256" || u.Query().Get("state") != "state" {
		t.Fatalf("authorization: %s", raw)
	}
	if requests != 1 {
		t.Fatalf("cache missed: %d requests", requests)
	}
	d.mu.Lock()
	d.cuando = time.Now().Add(-ttlDiscovery - time.Second)
	d.mu.Unlock()
	status = http.StatusInternalServerError
	if got, err := d.Endpoints(ctx, cfg); err != nil || got != e || requests != 2 {
		t.Fatalf("stale fallback: %v, requests=%d", err, requests)
	}
	if _, err := NuevoDiscovery().Endpoints(ctx, cfg); err == nil {
		t.Fatal("cold discovery accepted HTTP 500")
	}
	status, incomplete = http.StatusOK, true
	if _, err := NuevoDiscovery().Endpoints(ctx, cfg); err == nil {
		t.Fatal("incomplete discovery accepted")
	}
}
