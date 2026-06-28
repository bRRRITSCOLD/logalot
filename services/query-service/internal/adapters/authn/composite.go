package authn

import (
	"context"
	"strings"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// apiKeyScheme is the fixed prefix every ingest API key carries
// (pkg/auth keyPrefix "lgk" + separator "_"). It is the sole discriminator the
// Composite routes on: a presented credential beginning with it is an API key;
// anything else is treated as a UI session JWT. The prefix is a routing hint
// only — each delegate still fully verifies the credential it is handed.
const apiKeyScheme = "lgk_"

// Composite is the edge kernel.Authenticator that lets query-service accept BOTH
// machine API keys (ingest/dev tooling) and human UI session JWTs (control-plane
// issued) on the same endpoints. It inspects the credential SHAPE and delegates:
// an `lgk_`-prefixed value to the API-key authenticator, everything else to the
// JWT authenticator. It owns no verification logic itself — both paths fail
// closed in their respective delegate.
type Composite struct {
	apiKey kernel.Authenticator
	jwt    kernel.Authenticator
}

// compile-time proof the composite satisfies the kernel port.
var _ kernel.Authenticator = (*Composite)(nil)

// NewComposite wires the two delegates. apiKey is the shared pkg/auth
// Authenticator (RLS-backed key lookup); jwt is the control-plane session-token
// verifier.
func NewComposite(apiKey, jwt kernel.Authenticator) *Composite {
	return &Composite{apiKey: apiKey, jwt: jwt}
}

// Authenticate routes by credential shape. httpkit.CredentialFromRequest stashes
// the raw Bearer/X-API-Key value in Credential.APIKey, so the raw value is read
// from there first (falling back to BearerToken for a direct caller). The raw
// value is then handed to the matching delegate in the field that delegate reads:
// APIKey for the key path, BearerToken for the JWT path — so each delegate sees a
// credential in its expected shape.
func (c *Composite) Authenticate(ctx context.Context, cred kernel.Credential) (kernel.TenantContext, error) {
	raw := cred.APIKey
	if raw == "" {
		raw = cred.BearerToken
	}
	if strings.HasPrefix(raw, apiKeyScheme) {
		return c.apiKey.Authenticate(ctx, kernel.Credential{APIKey: raw})
	}
	return c.jwt.Authenticate(ctx, kernel.Credential{BearerToken: raw})
}
