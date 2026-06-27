package httpx

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/bRRRITSCOLD/logalot/services/query-service/internal/app"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Paneler is the port the panel-data handler depends on.
type Paneler interface {
	Data(ctx context.Context, tc kernel.TenantContext, q app.PanelQuery) (*app.PanelData, error)
}

// compile-time proof the app service satisfies the handler's port.
var _ Paneler = (*app.PanelService)(nil)

// PanelData handles GET /v1/panel-data.
//
//	?savedQueryId=<uuid>  – required; must be a valid UUID v4 (RFC 4122)
//	?from=<RFC3339>       – optional; default: now - 1h
//	?to=<RFC3339>         – optional; default: now
//	?buckets=<int>        – optional; default 30, max 100
//	?recentLimit=<int>    – optional; default 20, max 100
//
// Tenant isolation flows from the verified JWT → TenantContext → PanelStore,
// which arms SET LOCAL app.tenant_id before every DB access. A savedQueryId
// from a different tenant is invisible (RLS) → 404.
//
// Time-series contract: the buckets array in the response is SPARSE — buckets
// with zero matching events are omitted. The caller must gap-fill missing
// buckets with a zero count when rendering a continuous chart.
func (h *Handler) PanelData(c *gin.Context) {
	tc, ok := tenantFromGin(c)
	if !ok {
		abortUnauthorized(c)
		return
	}

	q, err := parsePanelQuery(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, errorBody("invalid_request", err.Error()))
		return
	}

	data, err := h.panel.Data(c.Request.Context(), tc, q)
	if err != nil {
		h.log.ErrorContext(c.Request.Context(), "panel-data failed",
			"tenant_id", string(tc.TenantID),
			"saved_query_id", q.SavedQueryID,
			"err", err)
		c.JSON(http.StatusInternalServerError, errorBody("internal", "panel data query failed"))
		return
	}
	if data == nil {
		c.JSON(http.StatusNotFound, errorBody("not_found", "saved query not found"))
		return
	}
	c.JSON(http.StatusOK, data)
}

// parsePanelQuery validates and extracts the panel-data query parameters.
func parsePanelQuery(c *gin.Context) (app.PanelQuery, error) {
	var q app.PanelQuery

	sq := strings.TrimSpace(c.Query("savedQueryId"))
	if sq == "" {
		return q, errors.New("savedQueryId is required")
	}
	// Validate UUID shape at the edge so malformed IDs (e.g. "invalid input syntax
	// for type uuid") surface as 400 Bad Request rather than reaching the DB and
	// returning a 500 or a misleading 404 (#52).
	if _, err := uuid.Parse(sq); err != nil {
		return q, errors.New("savedQueryId must be a valid UUID")
	}
	q.SavedQueryID = sq

	if from := strings.TrimSpace(c.Query("from")); from != "" {
		t, err := time.Parse(time.RFC3339, from)
		if err != nil {
			return q, errors.New("invalid 'from' (want RFC3339 timestamp)")
		}
		q.From = t
	}
	if to := strings.TrimSpace(c.Query("to")); to != "" {
		t, err := time.Parse(time.RFC3339, to)
		if err != nil {
			return q, errors.New("invalid 'to' (want RFC3339 timestamp)")
		}
		q.To = t
	}
	if !q.From.IsZero() && !q.To.IsZero() && !q.From.Before(q.To) {
		return q, errors.New("'from' must be before 'to'")
	}

	if b := strings.TrimSpace(c.Query("buckets")); b != "" {
		n, err := strconv.Atoi(b)
		if err != nil || n <= 0 || n > 100 {
			return q, errors.New("invalid buckets (want 1..100)")
		}
		q.Buckets = n
	}
	if r := strings.TrimSpace(c.Query("recentLimit")); r != "" {
		n, err := strconv.Atoi(r)
		if err != nil || n <= 0 || n > app.MaxRecentLogsLimit {
			return q, errors.New("invalid recentLimit (want 1..100)")
		}
		q.RecentLimit = n
	}

	return q, nil
}
