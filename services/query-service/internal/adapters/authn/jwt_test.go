package authn

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/golang-jwt/jwt/v5"
)

// These unit tests pin the control-plane access-token contract that
// query-service must accept (services/control-plane/src/adapters/crypto/
// jose-token-service.ts): HS256 over JWT_SECRET, with iss=logalot-control-plane,
// aud=logalot, sub=principal, tenant_id=<uuid>, role, iat, exp. They prove the
// authenticator validates signature + iss + aud + exp + alg and derives the
// tenant SOLELY from the tenant_id claim.

const (
	testSecret  = "dev-jwt-secret-change-me-0123456789"
	testTenant  = "11111111-1111-1111-1111-111111111111"
	otherTenant = "99999999-9999-9999-9999-999999999999"
	testSub     = "44444444-4444-4444-4444-444444444444"
)

// signToken mints an HS256 token with the given claims using the given secret and
// signing method override, mirroring how control-plane's JoseTokenService signs.
type tokenSpec struct {
	secret    string
	method    jwt.SigningMethod
	issuer    string
	audience  string
	subject   string
	tenantID  any // any so a test can omit it or set a non-string
	role      string
	issuedAt  time.Time
	expiresAt time.Time
	omitExp   bool
}

func defaultSpec() tokenSpec {
	now := time.Now()
	return tokenSpec{
		secret:    testSecret,
		method:    jwt.SigningMethodHS256,
		issuer:    tokenIssuer,
		audience:  tokenAudience,
		subject:   testSub,
		tenantID:  testTenant,
		role:      string(kernel.RoleMember),
		issuedAt:  now,
		expiresAt: now.Add(15 * time.Minute),
	}
}

func (s tokenSpec) sign(t *testing.T) string {
	t.Helper()
	claims := jwt.MapClaims{
		"iss":  s.issuer,
		"aud":  s.audience,
		"sub":  s.subject,
		"role": s.role,
		"iat":  jwt.NewNumericDate(s.issuedAt),
	}
	if s.tenantID != nil {
		claims["tenant_id"] = s.tenantID
	}
	if !s.omitExp {
		claims["exp"] = jwt.NewNumericDate(s.expiresAt)
	}
	tok := jwt.NewWithClaims(s.method, claims)
	var key any = []byte(s.secret)
	if s.method == jwt.SigningMethodNone {
		key = jwt.UnsafeAllowNoneSignatureType
	}
	str, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return str
}

func newJWT(t *testing.T) *JWTAuthenticator {
	t.Helper()
	a, err := NewJWT(testSecret)
	if err != nil {
		t.Fatalf("NewJWT: %v", err)
	}
	return a
}

func TestJWT_ValidTokenYieldsTenantScopedContext(t *testing.T) {
	a := newJWT(t)
	tok := defaultSpec().sign(t)

	tc, err := a.Authenticate(context.Background(), kernel.Credential{BearerToken: tok})
	if err != nil {
		t.Fatalf("Authenticate valid token: %v", err)
	}
	if tc.TenantID != kernel.TenantID(testTenant) {
		t.Errorf("TenantID = %q, want %q (from tenant_id claim)", tc.TenantID, testTenant)
	}
	if tc.PrincipalID != kernel.PrincipalID(testSub) {
		t.Errorf("PrincipalID = %q, want %q (from sub claim)", tc.PrincipalID, testSub)
	}
	if tc.Role != kernel.RoleMember {
		t.Errorf("Role = %q, want %q (from role claim)", tc.Role, kernel.RoleMember)
	}
	if err := tc.Valid(); err != nil {
		t.Errorf("resulting TenantContext is invalid: %v", err)
	}
}

// The tenant MUST come from the tenant_id claim and nothing else: a token whose
// subject/role differ but tenant_id is X must scope to X.
func TestJWT_TenantComesOnlyFromTenantIDClaim(t *testing.T) {
	a := newJWT(t)
	spec := defaultSpec()
	spec.tenantID = otherTenant
	spec.subject = testTenant // a red herring in sub must not be used as tenant
	tok := spec.sign(t)

	tc, err := a.Authenticate(context.Background(), kernel.Credential{BearerToken: tok})
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if tc.TenantID != kernel.TenantID(otherTenant) {
		t.Fatalf("TenantID = %q, want %q (must derive from tenant_id, not sub)", tc.TenantID, otherTenant)
	}
}

func TestJWT_RejectsBadTokens(t *testing.T) {
	a := newJWT(t)
	now := time.Now()

	cases := []struct {
		name string
		tok  func() string
	}{
		{"expired", func() string {
			s := defaultSpec()
			s.issuedAt = now.Add(-2 * time.Hour)
			s.expiresAt = now.Add(-time.Hour)
			return s.sign(t)
		}},
		{"missing exp", func() string {
			s := defaultSpec()
			s.omitExp = true
			return s.sign(t)
		}},
		{"wrong issuer", func() string {
			s := defaultSpec()
			s.issuer = "evil-issuer"
			return s.sign(t)
		}},
		{"wrong audience", func() string {
			s := defaultSpec()
			s.audience = "some-other-app"
			return s.sign(t)
		}},
		{"foreign signing key", func() string {
			s := defaultSpec()
			s.secret = "a-different-secret-not-ours-xxxxx"
			return s.sign(t)
		}},
		{"alg none", func() string {
			s := defaultSpec()
			s.method = jwt.SigningMethodNone
			return s.sign(t)
		}},
		{"non-HS256 (HS384)", func() string {
			s := defaultSpec()
			s.method = jwt.SigningMethodHS384
			return s.sign(t)
		}},
		{"missing tenant_id", func() string {
			s := defaultSpec()
			s.tenantID = nil
			return s.sign(t)
		}},
		{"non-uuid tenant_id", func() string {
			s := defaultSpec()
			s.tenantID = "not-a-uuid"
			return s.sign(t)
		}},
		{"empty tenant_id", func() string {
			s := defaultSpec()
			s.tenantID = ""
			return s.sign(t)
		}},
		{"unknown role", func() string {
			s := defaultSpec()
			s.role = "superuser"
			return s.sign(t)
		}},
		{"platform_operator barred from tenant logs", func() string {
			s := defaultSpec()
			s.role = string(kernel.RolePlatformOperator)
			return s.sign(t)
		}},
		{"empty subject", func() string {
			s := defaultSpec()
			s.subject = ""
			return s.sign(t)
		}},
		{"garbage string", func() string { return "not.a.jwt" }},
		{"empty string", func() string { return "" }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := a.Authenticate(context.Background(), kernel.Credential{BearerToken: tc.tok()})
			if err == nil {
				t.Fatalf("Authenticate(%s) = %+v, want rejection", tc.name, got)
			}
			if !errors.Is(err, ErrInvalidToken) {
				t.Errorf("err = %v, want it to wrap ErrInvalidToken (opaque 401)", err)
			}
			if got.TenantID != "" || got.PrincipalID != "" || got.Role != "" {
				t.Errorf("rejected auth must return a zero TenantContext, got %+v", got)
			}
		})
	}
}

// member and tenant_admin legitimately read logs, so both roles must be ACCEPTED
// (only platform_operator is barred — see TestJWT_RejectsBadTokens). This pins
// that the structural bar does not over-reach onto the log-reading roles.
func TestJWT_AcceptsLogReadingRoles(t *testing.T) {
	a := newJWT(t)
	for _, role := range []kernel.Role{kernel.RoleMember, kernel.RoleTenantAdmin} {
		t.Run(string(role), func(t *testing.T) {
			s := defaultSpec()
			s.role = string(role)
			tc, err := a.Authenticate(context.Background(), kernel.Credential{BearerToken: s.sign(t)})
			if err != nil {
				t.Fatalf("Authenticate role=%s: %v (must be accepted)", role, err)
			}
			if tc.Role != role {
				t.Fatalf("Role = %q, want %q", tc.Role, role)
			}
		})
	}
}

// A token whose alg is NOT HS256 must be rejected by the verifier rather than
// verified with the HMAC key. RS256->HS256 alg confusion is structurally
// inapplicable here (this verifier holds no asymmetric key — it cannot be
// tricked into MAC-verifying with a public key), so the real surface is alg=none
// and other HMAC variants. WithValidMethods allows ONLY HS256, so a token MAC'd
// with HS512 (a non-allowed HMAC variant standing in for "any other alg") is
// rejected before the key is ever used. (alg=none is also covered in the reject
// matrix above.)
func TestJWT_RejectsAlgConfusionForgery(t *testing.T) {
	a := newJWT(t)
	s := defaultSpec()
	s.method = jwt.SigningMethodHS512
	tok := s.sign(t)
	if _, err := a.Authenticate(context.Background(), kernel.Credential{BearerToken: tok}); err == nil {
		t.Fatal("a non-HS256 algorithm must be rejected (alg-confusion guard)")
	}
}

func TestJWT_ReadsTokenFromAPIKeyFieldToo(t *testing.T) {
	// Defensive: if wired without the composite (which normalizes into
	// BearerToken), the authenticator still finds the raw token in APIKey.
	a := newJWT(t)
	tok := defaultSpec().sign(t)
	if _, err := a.Authenticate(context.Background(), kernel.Credential{APIKey: tok}); err != nil {
		t.Fatalf("Authenticate via APIKey field: %v", err)
	}
}

func TestNewJWT_RejectsEmptySecret(t *testing.T) {
	if _, err := NewJWT(""); err == nil {
		t.Fatal("NewJWT(\"\") must fail: a verifier with no key cannot fail closed")
	}
}
