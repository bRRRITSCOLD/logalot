package httpkit

import (
	"net/http"
	"strings"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// bearerPrefix is the fixed prefix for Authorization: Bearer <token> headers.
const bearerPrefix = "Bearer "

// CredentialFromRequest extracts a credential from either
// `Authorization: Bearer <key>` or `X-API-Key: <key>`. ok is false when
// neither is present so the caller fails closed with 401.
//
// Security note: this is the single source of truth for credential extraction
// across all logalot HTTP services (ADR-0007, issue #39). Both the Bearer and
// X-API-Key paths whitespace-trim the extracted value so a token with a
// trailing newline (e.g. from a misconfigured client) is normalised rather
// than silently rejected. Authorization takes precedence over X-API-Key when
// both are present.
func CredentialFromRequest(r *http.Request) (kernel.Credential, bool) {
	if h := r.Header.Get("Authorization"); h != "" {
		if len(h) > len(bearerPrefix) && strings.EqualFold(h[:len(bearerPrefix)], bearerPrefix) {
			if key := strings.TrimSpace(h[len(bearerPrefix):]); key != "" {
				return kernel.Credential{APIKey: key}, true
			}
		}
	}
	if k := strings.TrimSpace(r.Header.Get("X-API-Key")); k != "" {
		return kernel.Credential{APIKey: k}, true
	}
	return kernel.Credential{}, false
}
