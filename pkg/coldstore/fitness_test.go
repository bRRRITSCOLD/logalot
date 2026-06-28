package coldstore

import (
	"errors"
	"testing"
)

// TestCheckTenantPredicate is the table-driven unit test for the SQL fitness
// function (NFR-6: every cold query must carry a static tenant_id = '<ctx>'
// predicate before StartQueryExecution). The check is structural (AST
// tokenizer + parser), not a substring scan.
func TestCheckTenantPredicate(t *testing.T) {
	const tid = "aaaaaaaa-0000-0000-0000-000000000001"

	cases := []struct {
		name    string
		sql     string
		wantErr bool
	}{
		// --- passing cases ---
		{
			name: "canonical generated SQL",
			sql: "SELECT ts, id, service, level, message, labels\n" +
				"FROM logalot_cold.log_events\n" +
				"WHERE tenant_id = '" + tid + "'\n" +
				"  AND dt BETWEEN '2026-01-01' AND '2026-06-27'\n" +
				"  AND ( '' = '' OR regexp_like(message, '') )\n" +
				"  AND ( '' = '' OR service = '' )\n" +
				"ORDER BY ts DESC\nLIMIT 50",
			wantErr: false,
		},
		{
			name:    "tenant predicate first, no other clauses",
			sql:     "SELECT * FROM t WHERE tenant_id = '" + tid + "'",
			wantErr: false,
		},
		{
			name:    "tenant predicate after another clause",
			sql:     "SELECT * FROM t WHERE dt = '2026-01-01' AND tenant_id = '" + tid + "'",
			wantErr: false,
		},
		{
			name:    "tenant predicate last with LIMIT",
			sql:     "SELECT * FROM t WHERE dt = '2026-01-01' AND tenant_id = '" + tid + "' ORDER BY ts DESC LIMIT 100",
			wantErr: false,
		},
		{
			name:    "tenant predicate with BETWEEN before it",
			sql:     "SELECT * FROM t WHERE dt BETWEEN '2026-01-01' AND '2026-06-27' AND tenant_id = '" + tid + "'",
			wantErr: false,
		},
		// --- failing cases ---
		{
			name:    "no WHERE clause",
			sql:     "SELECT * FROM t LIMIT 10",
			wantErr: true,
		},
		{
			name:    "WHERE with no tenant predicate",
			sql:     "SELECT * FROM t WHERE dt = '2026-01-01'",
			wantErr: true,
		},
		{
			name:    "wrong tenant ID",
			sql:     "SELECT * FROM t WHERE tenant_id = 'bbbbbbbb-0000-0000-0000-000000000002'",
			wantErr: true,
		},
		{
			name:    "wrong column name (tenant_id_extra)",
			sql:     "SELECT * FROM t WHERE tenant_id_extra = '" + tid + "'",
			wantErr: true,
		},
		{
			name:    "LIKE not equality",
			sql:     "SELECT * FROM t WHERE tenant_id LIKE '" + tid + "%'",
			wantErr: true,
		},
		{
			name:    "tenant predicate inside OR (ambiguous — fail-closed)",
			sql:     "SELECT * FROM t WHERE (tenant_id = '" + tid + "' OR dt = '2026-01-01')",
			wantErr: true,
		},
		{
			name:    "tenant predicate inside extra parens (fail-closed)",
			sql:     "SELECT * FROM t WHERE (tenant_id = '" + tid + "')",
			wantErr: true,
		},
		{
			name:    "empty SQL",
			sql:     "",
			wantErr: true,
		},
		{
			name:    "empty tenant ID",
			sql:     "SELECT * FROM t WHERE tenant_id = ''",
			wantErr: true, // empty tenantID arg → immediate reject
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// For the "empty tenant ID" case we call with a blank tenantID.
			tID := tid
			if tc.name == "empty tenant ID" {
				tID = ""
			}
			err := CheckTenantPredicate(tc.sql, tID)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("CheckTenantPredicate(%q) = nil, want error", tc.sql)
				}
				if !errors.Is(err, ErrMissingTenantPredicate) {
					t.Errorf("error is not ErrMissingTenantPredicate: %v", err)
				}
			} else {
				if err != nil {
					t.Fatalf("CheckTenantPredicate(%q) = %v, want nil", tc.sql, err)
				}
			}
		})
	}
}

// TestTokenize_BasicCoverage validates the tokenizer's token-kind assignments
// on a mini SQL so changes to the tokenizer are immediately caught.
func TestTokenize_BasicCoverage(t *testing.T) {
	sql := "WHERE tenant_id = 'uuid' AND dt BETWEEN '2026-01-01' AND '2026-06-27'"
	toks := tokenize(sql)

	want := []struct {
		kind tokKind
		val  string
	}{
		{tokKW, "WHERE"},
		{tokIdent, "tenant_id"},
		{tokOp, "="},
		{tokString, "uuid"},
		{tokKW, "AND"},
		{tokIdent, "dt"},
		{tokKW, "BETWEEN"},
		{tokString, "2026-01-01"},
		{tokKW, "AND"},
		{tokString, "2026-06-27"},
	}

	if len(toks) != len(want) {
		t.Fatalf("tokenize: got %d tokens, want %d\ntokens: %v", len(toks), len(want), toks)
	}
	for i, w := range want {
		if toks[i].kind != w.kind || toks[i].val != w.val {
			t.Errorf("token[%d]: got {%v %q}, want {%v %q}",
				i, toks[i].kind, toks[i].val, w.kind, w.val)
		}
	}
}

// TestSplitTopLevelAND verifies the BETWEEN-aware AND splitter does not split
// inside BETWEEN expressions but does split between independent predicates.
func TestSplitTopLevelAND(t *testing.T) {
	sql := "tenant_id = 'uuid' AND dt BETWEEN '2026-01-01' AND '2026-06-27' AND service = 'orders'"
	toks := tokenize(sql)
	terms := splitTopLevelAND(toks)

	if len(terms) != 3 {
		t.Fatalf("splitTopLevelAND: got %d terms, want 3\nterms: %v", len(terms), terms)
	}
	// term[0]: tenant_id = 'uuid'
	if len(terms[0]) != 3 {
		t.Errorf("term[0]: got %d tokens, want 3: %v", len(terms[0]), terms[0])
	}
	// term[1]: dt BETWEEN '...' AND '...' (5 tokens)
	if len(terms[1]) != 5 {
		t.Errorf("term[1]: got %d tokens, want 5 (BETWEEN term): %v", len(terms[1]), terms[1])
	}
	// term[2]: service = 'orders'
	if len(terms[2]) != 3 {
		t.Errorf("term[2]: got %d tokens, want 3: %v", len(terms[2]), terms[2])
	}
}
