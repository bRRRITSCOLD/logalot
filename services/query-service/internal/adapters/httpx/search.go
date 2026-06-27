package httpx

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
	"github.com/gin-gonic/gin"
)

// Searcher is the port the search handler depends on — the app core. Keeping it an
// interface lets handler tests drive a fake without standing up Postgres, while
// the real app.Searcher (over the kernel.LogStore) satisfies it in production.
type Searcher interface {
	Search(tc kernel.TenantContext, ctx context.Context, q kernel.SearchQuery) (kernel.SearchPage, error)
}

// compile-time proof the app service satisfies the handler's port.
var _ Searcher = (*app.Searcher)(nil)

// searchResponse is the JSON body of GET /v1/search: the page of events plus an
// opaque nextCursor (omitted on the final page). Clients pass nextCursor straight
// back via ?cursor= to fetch the following page.
type searchResponse struct {
	Events     []kernel.LogEvent `json:"events"`
	NextCursor string            `json:"nextCursor,omitempty"`
}

// Search handles GET /v1/search. It derives the TenantContext from the verified
// credential (never from a query param), parses + validates the filters, and runs
// a keyset-paginated hot search. Bad params are 401-after-auth/400; the tenant
// scoping and FTS-parse safety are enforced in the store, so user input can never
// cross a tenant boundary or 500 the query.
func (h *Handler) Search(c *gin.Context) {
	tc, ok := tenantFromGin(c)
	if !ok {
		// Defensive: AuthMiddleware guarantees a tenant, but fail closed anyway.
		abortUnauthorized(c)
		return
	}
	q, err := parseSearchQuery(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, errorBody("invalid_request", err.Error()))
		return
	}

	page, err := h.search.Search(tc, c.Request.Context(), q)
	if err != nil {
		// The tenant came from auth (already valid), so an error here is a backend
		// fault, not a client one: log it and return an opaque 500.
		h.log.ErrorContext(c.Request.Context(), "search failed",
			"tenant_id", string(tc.TenantID), "err", err)
		c.JSON(http.StatusInternalServerError, errorBody("internal", "search failed"))
		return
	}

	events := page.Events
	if events == nil {
		events = []kernel.LogEvent{} // render [] not null for an empty page
	}
	c.JSON(http.StatusOK, searchResponse{
		Events:     events,
		NextCursor: encodeCursor(page.NextCursor),
	})
}

// parseSearchQuery maps the query string into a kernel.SearchQuery, validating
// every caller-supplied value (a 400 surfaces before any DB work). The tenant is
// NOT read here — it is bound from the authenticated context in the store.
func parseSearchQuery(c *gin.Context) (kernel.SearchQuery, error) {
	var q kernel.SearchQuery
	q.Text = strings.TrimSpace(c.Query("q"))
	q.Service = strings.TrimSpace(c.Query("service"))

	if lvl := strings.TrimSpace(c.Query("level")); lvl != "" {
		var level kernel.Level
		// Reuse the kernel's fail-closed level parsing (rejects unknown levels).
		if err := level.UnmarshalJSON([]byte(`"` + lvl + `"`)); err != nil {
			return kernel.SearchQuery{}, fmt.Errorf("invalid level %q", lvl)
		}
		q.Level = &level
	}

	if from := strings.TrimSpace(c.Query("from")); from != "" {
		t, err := time.Parse(time.RFC3339, from)
		if err != nil {
			return kernel.SearchQuery{}, errors.New("invalid 'from' (want RFC3339 timestamp)")
		}
		q.From = t
	}
	if to := strings.TrimSpace(c.Query("to")); to != "" {
		t, err := time.Parse(time.RFC3339, to)
		if err != nil {
			return kernel.SearchQuery{}, errors.New("invalid 'to' (want RFC3339 timestamp)")
		}
		q.To = t
	}
	if !q.From.IsZero() && !q.To.IsZero() && !q.From.Before(q.To) {
		return kernel.SearchQuery{}, errors.New("'from' must be before 'to'")
	}

	if lim := strings.TrimSpace(c.Query("limit")); lim != "" {
		n, err := strconv.Atoi(lim)
		if err != nil || n <= 0 || n > app.MaxSearchLimit {
			return kernel.SearchQuery{}, fmt.Errorf("invalid limit (want 1..%d)", app.MaxSearchLimit)
		}
		q.Limit = n
	}

	if cur := strings.TrimSpace(c.Query("cursor")); cur != "" {
		cursor, err := decodeCursor(cur)
		if err != nil {
			return kernel.SearchQuery{}, err
		}
		q.Cursor = cursor
	}

	labels, err := parseLabels(c.QueryArray("label"))
	if err != nil {
		return kernel.SearchQuery{}, err
	}
	q.Labels = labels

	return q, nil
}

// parseLabels turns repeated ?label=key=value params into the containment map
// searched via `labels @> $`. Each pair splits on the FIRST '=', so values may
// themselves contain '='. A pair with an empty key is a 400.
func parseLabels(pairs []string) (map[string]string, error) {
	if len(pairs) == 0 {
		return nil, nil
	}
	m := make(map[string]string, len(pairs))
	for _, p := range pairs {
		k, v, ok := strings.Cut(p, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			return nil, fmt.Errorf("invalid label %q (want key=value)", p)
		}
		m[k] = v
	}
	return m, nil
}
