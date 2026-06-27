package httpkit

import (
	"net/http"
	"testing"
)

func TestCredentialFromRequest_BearerHeader(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer mytoken")
	cred, ok := CredentialFromRequest(r)
	if !ok {
		t.Fatal("ok=false, want true for Bearer header")
	}
	if cred.APIKey != "mytoken" {
		t.Errorf("APIKey=%q, want %q", cred.APIKey, "mytoken")
	}
}

func TestCredentialFromRequest_BearerCaseInsensitive(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "bearer mytoken")
	cred, ok := CredentialFromRequest(r)
	if !ok {
		t.Fatal("ok=false, want true for case-insensitive bearer prefix")
	}
	if cred.APIKey != "mytoken" {
		t.Errorf("APIKey=%q, want %q", cred.APIKey, "mytoken")
	}
}

func TestCredentialFromRequest_BearerWhitespaceTrimmed(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer  mytoken  ")
	cred, ok := CredentialFromRequest(r)
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if cred.APIKey != "mytoken" {
		t.Errorf("APIKey=%q, want trimmed %q", cred.APIKey, "mytoken")
	}
}

func TestCredentialFromRequest_XAPIKeyHeader(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-API-Key", "myapikey")
	cred, ok := CredentialFromRequest(r)
	if !ok {
		t.Fatal("ok=false, want true for X-API-Key header")
	}
	if cred.APIKey != "myapikey" {
		t.Errorf("APIKey=%q, want %q", cred.APIKey, "myapikey")
	}
}

func TestCredentialFromRequest_XAPIKeyWhitespaceTrimmed(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-API-Key", "  myapikey  ")
	cred, ok := CredentialFromRequest(r)
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if cred.APIKey != "myapikey" {
		t.Errorf("APIKey=%q, want trimmed %q", cred.APIKey, "myapikey")
	}
}

// The load-bearing precedence test: when both headers are present, Authorization
// (Bearer) takes precedence over X-API-Key.
func TestCredentialFromRequest_BearerTakesPrecedenceOverXAPIKey(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer bearer_token")
	r.Header.Set("X-API-Key", "xapi_token")
	cred, ok := CredentialFromRequest(r)
	if !ok {
		t.Fatal("ok=false, want true")
	}
	if cred.APIKey != "bearer_token" {
		t.Errorf("APIKey=%q, want bearer_token (Authorization takes precedence over X-API-Key)", cred.APIKey)
	}
}

func TestCredentialFromRequest_MissingCredential(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	_, ok := CredentialFromRequest(r)
	if ok {
		t.Fatal("ok=true, want false for missing credential")
	}
}

func TestCredentialFromRequest_EmptyBearerValue(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer ")
	_, ok := CredentialFromRequest(r)
	if ok {
		t.Fatal("ok=true, want false for empty Bearer value (whitespace only)")
	}
}

func TestCredentialFromRequest_OnlyBearerPrefixNoSpace(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	// "Bearer" alone — len(h) == len(bearerPrefix) so the check fails correctly.
	r.Header.Set("Authorization", "Bearer")
	_, ok := CredentialFromRequest(r)
	if ok {
		t.Fatal("ok=true, want false for Authorization: Bearer (no value)")
	}
}
