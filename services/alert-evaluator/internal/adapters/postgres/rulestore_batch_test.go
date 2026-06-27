package postgres

import (
	"encoding/json"
	"testing"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/alert-evaluator/internal/app"
)

// Tests for applyBatchResolutions — the apply step extracted from
// resolveSavedQueriesBatch so it can be proven without a database.

const (
	sqID  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	sqID2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	tA    = kernel.TenantID("11111111-1111-1111-1111-111111111111")
	tB    = kernel.TenantID("22222222-2222-2222-2222-222222222222")
)

func filtersJSON(t *testing.T, service, level string, labels map[string]string) []byte {
	t.Helper()
	v := struct {
		Service string            `json:"service,omitempty"`
		Level   string            `json:"level,omitempty"`
		Labels  map[string]string `json:"labels,omitempty"`
	}{Service: service, Level: level, Labels: labels}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestApplyBatchResolutions_PopulatesQueryFromLookup proves the happy-path:
// a rule referencing a saved_query_id gets its Query populated from the lookup.
func TestApplyBatchResolutions_PopulatesQueryFromLookup(t *testing.T) {
	rules := []app.Rule{
		{ID: "r1", TenantID: tA, SavedQueryID: sqID},
	}
	lookup := map[savedQueryKey]savedQueryResolution{
		{sqID, string(tA)}: {
			queryText:  "error",
			filtersRaw: filtersJSON(t, "billing", "error", map[string]string{"region": "us-east-1"}),
		},
	}

	applyBatchResolutions(rules, lookup)

	if rules[0].Query.Text != "error" {
		t.Errorf("Query.Text = %q, want %q", rules[0].Query.Text, "error")
	}
	if rules[0].Query.Service != "billing" {
		t.Errorf("Query.Service = %q, want %q", rules[0].Query.Service, "billing")
	}
	if rules[0].Query.Level == nil || *rules[0].Query.Level != kernel.LevelError {
		t.Errorf("Query.Level = %v, want error", rules[0].Query.Level)
	}
	if rules[0].Query.Labels["region"] != "us-east-1" {
		t.Errorf("Query.Labels[region] = %q, want us-east-1", rules[0].Query.Labels["region"])
	}
}

// TestApplyBatchResolutions_TenantIsolation proves that a saved_query entry in
// the lookup for tenant B is NOT applied to a rule belonging to tenant A, even
// when the savedQueryID is the same — the (id, tenantID) composite key enforces
// the boundary.
func TestApplyBatchResolutions_TenantIsolation(t *testing.T) {
	rules := []app.Rule{
		{ID: "rA", TenantID: tA, SavedQueryID: sqID},
		{ID: "rB", TenantID: tB, SavedQueryID: sqID},
	}
	// Only tenant B's saved query is in the lookup.
	lookup := map[savedQueryKey]savedQueryResolution{
		{sqID, string(tB)}: {queryText: "tenant-b-query"},
	}

	applyBatchResolutions(rules, lookup)

	// Tenant A's rule must stay empty — its saved query was not in the lookup.
	if !rules[0].Query.IsEmpty() {
		t.Errorf("tenant A rule should have an empty query, got %+v", rules[0].Query)
	}
	// Tenant B's rule should be populated.
	if rules[1].Query.Text != "tenant-b-query" {
		t.Errorf("tenant B rule Query.Text = %q, want %q", rules[1].Query.Text, "tenant-b-query")
	}
}

// TestApplyBatchResolutions_BatchResolvesManyRules proves that all rules in a
// batch are populated in a single call (i.e. the apply step handles multiple
// rules with different saved_query_ids across tenants correctly).
func TestApplyBatchResolutions_BatchResolvesManyRules(t *testing.T) {
	rules := []app.Rule{
		{ID: "r1", TenantID: tA, SavedQueryID: sqID},
		{ID: "r2", TenantID: tA, SavedQueryID: sqID2},
		{ID: "r3", TenantID: tB, SavedQueryID: sqID},
	}
	lookup := map[savedQueryKey]savedQueryResolution{
		{sqID, string(tA)}:  {queryText: "query-a1"},
		{sqID2, string(tA)}: {queryText: "query-a2"},
		{sqID, string(tB)}:  {queryText: "query-b1"},
	}

	applyBatchResolutions(rules, lookup)

	cases := []struct{ wantText string }{
		{"query-a1"},
		{"query-a2"},
		{"query-b1"},
	}
	for i, c := range cases {
		if rules[i].Query.Text != c.wantText {
			t.Errorf("rules[%d].Query.Text = %q, want %q", i, rules[i].Query.Text, c.wantText)
		}
	}
}

// TestApplyBatchResolutions_SkipsRulesWithInlineQuery proves that rules that
// already have an inline query are not overwritten by a matching lookup entry.
func TestApplyBatchResolutions_SkipsRulesWithInlineQuery(t *testing.T) {
	rules := []app.Rule{
		{
			ID:           "r1",
			TenantID:     tA,
			SavedQueryID: sqID,
			Query:        app.RuleQuery{Text: "inline"}, // already populated
		},
	}
	lookup := map[savedQueryKey]savedQueryResolution{
		{sqID, string(tA)}: {queryText: "from-saved-query"},
	}

	applyBatchResolutions(rules, lookup)

	if rules[0].Query.Text != "inline" {
		t.Errorf("inline query should not be overwritten, got %q", rules[0].Query.Text)
	}
}

// TestApplyBatchResolutions_MissingLookupLeavesQueryEmpty proves that a rule
// whose saved_query is absent from the lookup (deleted/wrong tenant) keeps an
// empty Query so the evaluator's IsEmpty guard skips it gracefully.
func TestApplyBatchResolutions_MissingLookupLeavesQueryEmpty(t *testing.T) {
	rules := []app.Rule{
		{ID: "r1", TenantID: tA, SavedQueryID: sqID},
	}
	// Empty lookup — saved query was deleted.
	lookup := map[savedQueryKey]savedQueryResolution{}

	applyBatchResolutions(rules, lookup)

	if !rules[0].Query.IsEmpty() {
		t.Errorf("missing saved_query must leave Query empty, got %+v", rules[0].Query)
	}
}
