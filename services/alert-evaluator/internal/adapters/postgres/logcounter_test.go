package postgres

import (
	"strings"
	"testing"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
)

func TestBuildCount_TenantPredicateAndWindowAlwaysBound(t *testing.T) {
	from := time.Date(2026, 6, 27, 10, 0, 0, 0, time.UTC)
	to := from.Add(5 * time.Minute)
	sql, args, err := buildCount("00000000-0000-0000-0000-00000000000a", app.RuleQuery{}, from, to)
	if err != nil {
		t.Fatalf("buildCount: %v", err)
	}
	if !strings.HasPrefix(sql, "SELECT count(*) FROM log_events WHERE tenant_id = $1::uuid") {
		t.Fatalf("count must lead with tenant predicate, got: %s", sql)
	}
	if !strings.Contains(sql, "ts >= $2") || !strings.Contains(sql, "ts < $3") {
		t.Fatalf("window must be bound as $2/$3, got: %s", sql)
	}
	// $1 tenant, $2 from, $3 to.
	if len(args) != 3 {
		t.Fatalf("args = %d, want 3 (tenant, from, to)", len(args))
	}
	if args[0] != "00000000-0000-0000-0000-00000000000a" {
		t.Fatalf("args[0] = %v, want tenant id", args[0])
	}
}

func TestBuildCount_AllFiltersAppendedAsBoundParams(t *testing.T) {
	from := time.Now().Add(-time.Minute)
	to := time.Now()
	lvl := kernel.LevelError
	q := app.RuleQuery{
		Text:    "payment failed",
		Service: "billing",
		Level:   &lvl,
		Labels:  map[string]string{"region": "us-east-1"},
	}
	sql, args, err := buildCount("00000000-0000-0000-0000-00000000000a", q, from, to)
	if err != nil {
		t.Fatalf("buildCount: %v", err)
	}
	for _, frag := range []string{
		"websearch_to_tsquery('english',",
		"labels @>",
		"service =",
		"level =",
		"::log_level",
	} {
		if !strings.Contains(sql, frag) {
			t.Errorf("expected SQL to contain %q\nsql: %s", frag, sql)
		}
	}
	// tenant + from + to + text + labels + service + level = 7 bound params.
	if len(args) != 7 {
		t.Fatalf("args = %d, want 7", len(args))
	}
}

func TestBuildCount_NoTenantFieldOnQuery_TenantOnlyFromContext(t *testing.T) {
	// RuleQuery has no tenant field a caller could spoof — the tenant is ALWAYS
	// $1, bound from the passed tenant id (mirrors logstore's defense-in-depth).
	sql, args, _ := buildCount("11111111-1111-1111-1111-111111111111", app.RuleQuery{Service: "x"}, time.Now().Add(-time.Hour), time.Now())
	if strings.Count(sql, "$1::uuid") != 1 {
		t.Fatalf("tenant predicate must appear exactly once as $1::uuid, got: %s", sql)
	}
	if args[0] != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("args[0] = %v, want the passed tenant id", args[0])
	}
}
