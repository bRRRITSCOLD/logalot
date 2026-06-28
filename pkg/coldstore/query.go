package coldstore

import (
	"strconv"
	"strings"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
)

const (
	defaultSearchLimit = 50
	maxSearchLimit     = 1000
)

// buildColdQuery renders the Athena SELECT for a tenant-scoped cold search.
// The SQL template follows cold-tier.md §4 exactly:
//
//   - tenant_id = '<ctx_tenant_id>' is ALWAYS the first and unconditional
//     WHERE predicate (required by injected partition projection on real AWS
//     and verified by CheckTenantPredicate before execution).
//   - dt BETWEEN prunes date partitions (Hive-style, cost reduction NFR-4).
//   - Optional predicates use the `( :param = ” OR <expr> )` idiom so a
//     missing filter degrades to a no-op rather than raising an error.
//   - Labels: each key=value pair produces a json_extract_scalar predicate.
//
// Values are inlined as single-quoted literals (NOT bind parameters because
// Athena's PreparedStatement API is limited). User-controlled values are
// single-quote–escaped with escapeSQ to prevent SQL injection.
//
// The tenant_id literal is taken from tc.TenantID (verified UUID) and is NOT
// user-controlled — it is the authoritative context value (ADR-0002).
func buildColdQuery(tc kernel.TenantContext, q kernel.SearchQuery) string {
	var b strings.Builder

	tenantID := string(tc.TenantID)

	b.WriteString("SELECT ts, id, service, level, message, labels\n")
	b.WriteString("FROM logalot_cold.log_events\n")
	b.WriteString("WHERE tenant_id = '")
	b.WriteString(tenantID) // UUID — no escaping needed; isUUID validated by kernel
	b.WriteString("'")

	// dt BETWEEN prunes Hive date partitions (cold-tier.md §4).
	fromDate, toDate := timeBounds(q)
	b.WriteString("\n  AND dt BETWEEN '")
	b.WriteString(fromDate)
	b.WriteString("' AND '")
	b.WriteString(toDate)
	b.WriteString("'")

	// Optional text filter: ( '' = '' OR regexp_like(message, 'pattern') )
	text := strings.TrimSpace(q.Text)
	b.WriteString("\n  AND ( '")
	b.WriteString(escapeSQ(text))
	b.WriteString("' = '' OR regexp_like(message, '")
	b.WriteString(escapeSQ(text))
	b.WriteString("') )")

	// Optional service filter.
	svc := strings.TrimSpace(q.Service)
	b.WriteString("\n  AND ( '")
	b.WriteString(escapeSQ(svc))
	b.WriteString("' = '' OR service = '")
	b.WriteString(escapeSQ(svc))
	b.WriteString("' )")

	// Optional label predicates (each label key → json_extract_scalar predicate).
	for k, v := range q.Labels {
		b.WriteString("\n  AND json_extract_scalar(labels, '$.")
		b.WriteString(escapeSQ(k))
		b.WriteString("') = '")
		b.WriteString(escapeSQ(v))
		b.WriteString("'")
	}

	limit := q.Limit
	if limit <= 0 || limit > maxSearchLimit {
		limit = defaultSearchLimit
	}

	b.WriteString("\nORDER BY ts DESC\nLIMIT ")
	b.WriteString(strconv.Itoa(limit))

	return b.String()
}

// timeBounds returns the (from, to) date strings for the dt BETWEEN clause.
// When q.From/q.To are zero we default to a wide but bounded range so Athena
// doesn't scan beyond reasonable history.
func timeBounds(q kernel.SearchQuery) (string, string) {
	const dateLayout = "2006-01-02"
	from := "2026-01-01"
	to := time.Now().UTC().Format(dateLayout)
	if !q.From.IsZero() {
		from = q.From.UTC().Format(dateLayout)
	}
	if !q.To.IsZero() {
		to = q.To.UTC().Format(dateLayout)
	}
	return from, to
}

// escapeSQ escapes a string for embedding in a single-quoted Athena/SQL
// literal by replacing each `'` with `”` (standard SQL escaping).
// This is the only safe injection point — tenant_id uses the UUID from
// TenantContext (kernel-validated hex/dash, no escaping needed).
func escapeSQ(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}
