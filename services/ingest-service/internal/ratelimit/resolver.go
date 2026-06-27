package ratelimit

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

// StaticResolver resolves a tenant's Limits from a global Default plus an optional
// per-tenant Overrides map (ADR-0004 "global default + per-tenant override"). It
// is the KISS source of per-tenant limits: a tenant present in Overrides gets its
// own bucket sizing, everyone else gets Default.
//
// How to set a per-tenant limit: add the tenant to Overrides. In production this
// is populated from the INGEST_RATE_LIMIT_OVERRIDES env var (see ParseOverrides),
// e.g. INGEST_RATE_LIMIT_OVERRIDES="<tenant-uuid>=2000:4000,<tenant-uuid>=0:0"
// (rate:burst; 0:0 exempts a tenant). Because resolution is behind the Resolver
// port, a Redis- or control-plane-backed source can replace this later with no
// change to the limiter.
type StaticResolver struct {
	Default   Limits
	Overrides map[kernel.TenantID]Limits
}

// NewStaticResolver builds a StaticResolver. A nil overrides map is fine.
func NewStaticResolver(def Limits, overrides map[kernel.TenantID]Limits) *StaticResolver {
	return &StaticResolver{Default: def, Overrides: overrides}
}

// Resolve returns the tenant's override if one exists, otherwise the default.
func (r *StaticResolver) Resolve(tc kernel.TenantContext) Limits {
	if r.Overrides != nil {
		if lim, ok := r.Overrides[tc.TenantID]; ok {
			return lim
		}
	}
	return r.Default
}

// ParseOverrides parses the INGEST_RATE_LIMIT_OVERRIDES env format into a map. The
// format is a comma-separated list of `<tenant-uuid>=<rate>:<burst>` entries, e.g.
//
//	11111111-1111-1111-1111-111111111111=2000:4000,2222...=0:0
//
// A `0:0` (or any non-positive) entry exempts that tenant (Limits.Unlimited).
// Blank input yields an empty map. A malformed entry is a hard error so a typo in
// a tenant's limit fails the service at startup rather than silently misapplying.
func ParseOverrides(s string) (map[kernel.TenantID]Limits, error) {
	out := map[kernel.TenantID]Limits{}
	s = strings.TrimSpace(s)
	if s == "" {
		return out, nil
	}
	for _, entry := range strings.Split(s, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		id, spec, ok := strings.Cut(entry, "=")
		if !ok {
			return nil, fmt.Errorf("ratelimit: override %q missing '='", entry)
		}
		id = strings.TrimSpace(id)
		tc := kernel.TenantContext{TenantID: kernel.TenantID(id)}
		if err := tc.Valid(); err != nil {
			return nil, fmt.Errorf("ratelimit: override tenant id %q invalid: %w", id, err)
		}
		rateStr, burstStr, ok := strings.Cut(spec, ":")
		if !ok {
			return nil, fmt.Errorf("ratelimit: override %q value must be <rate>:<burst>", entry)
		}
		rate, err := strconv.ParseFloat(strings.TrimSpace(rateStr), 64)
		if err != nil {
			return nil, fmt.Errorf("ratelimit: override %q rate: %w", entry, err)
		}
		burst, err := strconv.ParseFloat(strings.TrimSpace(burstStr), 64)
		if err != nil {
			return nil, fmt.Errorf("ratelimit: override %q burst: %w", entry, err)
		}
		out[kernel.TenantID(id)] = Limits{Rate: rate, Burst: burst}
	}
	return out, nil
}
