package coldstore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/athena"
	athtypes "github.com/aws/aws-sdk-go-v2/service/athena/types"
	"github.com/aws/aws-sdk-go-v2/service/glue"
	glutypes "github.com/aws/aws-sdk-go-v2/service/glue/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/bRRRITSCOLD/logalot/pkg/kernel"
	"github.com/google/uuid"
)

// ErrColdSearchDisabled is returned by Search when the cold-search feature
// flag is off (decision 016 §6 — cold search stays feature-flagged until the
// real-AWS CI smoke test passes).
var ErrColdSearchDisabled = errors.New("coldstore: cold search is disabled (feature flag off)")

// Store is the ColdArchive port adapter: direct-write S3 Parquet + explicit
// Glue CreatePartition for writes; Athena (behind fitness-function gate) for
// reads. Implement kernel.ColdArchive.
type Store struct {
	// AWS clients (injected via options; nil in unit tests that use fakes)
	realS3     s3Putter
	realGlue   gluePartitioner
	realAthena athenaExecutor

	// Narrow functional closures — these are what the implementation calls.
	// In production they delegate to the real AWS clients; in unit tests they
	// are replaced by fakes. This avoids threading AWS client types into tests.
	s3Putter func(ctx context.Context, bucket, key string, body []byte) error
	gluePart func(ctx context.Context, database string, p gluePartition) error

	bucket             string
	glueDB             string
	athenaResultBucket string
	workgroup          string

	searchEnabled bool
	now           func() time.Time
	log           *slog.Logger
}

// --- narrow port interfaces ------------------------------------------------

type s3Putter interface {
	PutObject(ctx context.Context, params *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error)
}

type gluePartitioner interface {
	CreatePartition(ctx context.Context, params *glue.CreatePartitionInput, optFns ...func(*glue.Options)) (*glue.CreatePartitionOutput, error)
}

type athenaExecutor interface {
	StartQueryExecution(ctx context.Context, params *athena.StartQueryExecutionInput, optFns ...func(*athena.Options)) (*athena.StartQueryExecutionOutput, error)
	GetQueryExecution(ctx context.Context, params *athena.GetQueryExecutionInput, optFns ...func(*athena.Options)) (*athena.GetQueryExecutionOutput, error)
	GetQueryResults(ctx context.Context, params *athena.GetQueryResultsInput, optFns ...func(*athena.Options)) (*athena.GetQueryResultsOutput, error)
}

// compile-time proof the adapter satisfies the kernel port.
var _ kernel.ColdArchive = (*Store)(nil)

// Option configures a Store.
type Option func(*Store)

// WithSearchEnabled gates cold read behind a feature flag (decision 016 §6).
// Default is OFF — cold search requires the real-AWS smoke test to pass first.
func WithSearchEnabled(on bool) Option {
	return func(s *Store) { s.searchEnabled = on }
}

// WithLogger sets the structured logger used for best-effort failure warnings.
func WithLogger(l *slog.Logger) Option {
	return func(s *Store) { s.log = l }
}

// WithClock injects a clock (test seam for deterministic timestamps).
func WithClock(now func() time.Time) Option {
	return func(s *Store) { s.now = now }
}

// WithWorkgroup sets the Athena workgroup name (default: "primary").
func WithWorkgroup(wg string) Option {
	return func(s *Store) { s.workgroup = wg }
}

// New builds a Store wired to real AWS clients. bucket is the S3 cold bucket
// (e.g. "logalot-cold"), glueDB is the Glue database (e.g. "logalot_cold"),
// athenaResultBucket is the Athena output location (e.g.
// "s3://logalot-cold-results/").
//
// Cold search is OFF by default (decision 016 §6). Enable with
// WithSearchEnabled(true) only after the real-AWS smoke test passes.
func New(
	s3Client s3Putter,
	glueClient gluePartitioner,
	athenaClient athenaExecutor,
	bucket, glueDB, athenaResultBucket string,
	opts ...Option,
) *Store {
	st := &Store{
		realS3:             s3Client,
		realGlue:           glueClient,
		realAthena:         athenaClient,
		bucket:             bucket,
		glueDB:             glueDB,
		athenaResultBucket: athenaResultBucket,
		workgroup:          "primary",
		searchEnabled:      false, // feature-flagged OFF
		now:                time.Now,
		log:                slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	// Wire production closures from the real AWS clients.
	st.s3Putter = func(ctx context.Context, bkt, key string, body []byte) error {
		_, err := s3Client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(bkt),
			Key:         aws.String(key),
			Body:        bytes.NewReader(body),
			ContentType: aws.String("application/octet-stream"),
		})
		return err
	}
	st.gluePart = func(ctx context.Context, db string, p gluePartition) error {
		return createGluePartition(ctx, glueClient, db, bucket, p)
	}
	for _, o := range opts {
		o(st)
	}
	return st
}

// ---------------------------------------------------------------------------
// Archive — write path (kernel.ColdArchive).
// ---------------------------------------------------------------------------

// Archive tees events to the tenant's cold S3 prefix as a Parquet batch, then
// registers the partition in Glue (cold-tier.md §5.1, ADR-0005 §amended).
//
// Isolation invariants (ADR-0002, cold-tier.md §1):
//   - tenant_id stamped from tc.TenantID, NEVER from any event field.
//   - S3 key begins with logs/tenant_id=<tc.TenantID>/ — the structural cold
//     isolation boundary. No other tenant's prefix is ever written.
//
// Batching (M1 fix): events are grouped by their (dt, hour) partition derived
// from each event's own timestamp, and each group is written as its own Parquet
// object under the correct partition prefix. A single Archive call carrying a
// heterogeneous-timestamp batch therefore produces one object per (dt, hour)
// rather than mis-filing the whole batch under events[0]'s partition.
//
// Failure semantics:
//   - S3 PutObject failure → error returned (data not written; caller retries
//     the whole batch). Groups are written in deterministic partition order; a
//     failure on any group aborts and propagates so the processor retries.
//   - Glue CreatePartition failure → warning logged, non-fatal (data is already
//     in S3 and partition projection handles discovery for queries; decision
//     016 §1 and cold-tier.md §3 partition-projection note). The processor
//     treats Archive as a best-effort tee (§5.1).
func (s *Store) Archive(tc kernel.TenantContext, ctx context.Context, events ...kernel.LogEvent) error {
	if err := tc.Valid(); err != nil {
		return err
	}
	if len(events) == 0 {
		return nil
	}

	// Group events by their (dt, hour) partition so a heterogeneous-timestamp
	// batch is filed correctly (M1). The partition is derived from each event's
	// own TS (zero TS → s.now()), never from events[0].
	groups := s.partitionEvents(events)

	for _, g := range groups {
		// Encode this partition's events as Parquet. tenant_id is bound from tc
		// inside encodeParquet (never from any event body).
		data, err := encodeParquet(tc, g.events)
		if err != nil {
			return fmt.Errorf("coldstore: encode: %w", err)
		}

		batchID := uuid.New().String()
		key := coldKey(string(tc.TenantID), batchID, g.t)

		// S3 PutObject — failure is propagated (data must land in S3 for the
		// archive to be durable; the processor will retry the whole batch).
		if err := s.s3Putter(ctx, s.bucket, key, data); err != nil {
			return fmt.Errorf("coldstore: s3 put %q: %w", key, err)
		}

		// Glue CreatePartition — non-fatal; partition projection discovers the
		// prefix anyway, and a failed registration can be retried independently.
		part := gluePartition{
			tenantID: string(tc.TenantID),
			dt:       g.t.UTC().Format("2006-01-02"),
			hour:     fmt.Sprintf("%02d", g.t.UTC().Hour()),
		}
		if err := s.gluePart(ctx, s.glueDB, part); err != nil {
			s.log.WarnContext(ctx, "coldstore: glue partition registration failed (data in S3)",
				"tenant_id", tc.TenantID,
				"partition", fmt.Sprintf("dt=%s/hour=%s", part.dt, part.hour),
				"err", err)
			// Non-fatal: continue so the processor doesn't retry the whole tee.
		}
	}
	return nil
}

// eventGroup is a set of events that share a single (dt, hour) partition,
// together with a representative time t used to compute the S3 key + partition.
type eventGroup struct {
	t      time.Time
	events []kernel.LogEvent
}

// partitionEvents buckets events by their UTC (date, hour) partition. The
// representative time t of each group is the first event's resolved timestamp,
// which shares the group's dt/hour by construction. Groups are returned in
// ascending partition order for deterministic write sequencing.
func (s *Store) partitionEvents(events []kernel.LogEvent) []eventGroup {
	byPart := make(map[string]*eventGroup)
	order := make([]string, 0, 4)
	for _, ev := range events {
		t := ev.TS
		if t.IsZero() {
			t = s.now()
		}
		t = t.UTC()
		pk := t.Format("2006-01-02-15") // dt+hour bucket key
		g, ok := byPart[pk]
		if !ok {
			g = &eventGroup{t: t}
			byPart[pk] = g
			order = append(order, pk)
		}
		g.events = append(g.events, ev)
	}
	sort.Strings(order)
	out := make([]eventGroup, 0, len(order))
	for _, pk := range order {
		out = append(out, *byPart[pk])
	}
	return out
}

// ---------------------------------------------------------------------------
// Search — read path (kernel.ColdArchive).
// ---------------------------------------------------------------------------

// Search runs a tenant-scoped cold (Athena) query. It is gated behind a
// feature flag (ErrColdSearchDisabled when off). The generated SQL must pass
// CheckTenantPredicate before StartQueryExecution is called (NFR-6 / decision
// 016 §3 fitness function).
//
// The tenant_id predicate is bound from tc.TenantID (authoritative context),
// NEVER from q (which has no tenant field — ADR-0002).
func (s *Store) Search(tc kernel.TenantContext, ctx context.Context, q kernel.SearchQuery) (kernel.SearchPage, error) {
	if !s.searchEnabled {
		return kernel.SearchPage{}, ErrColdSearchDisabled
	}
	if err := tc.Valid(); err != nil {
		return kernel.SearchPage{}, err
	}
	if s.realAthena == nil {
		return kernel.SearchPage{}, errors.New("coldstore: Athena client not configured")
	}

	sql := buildColdQuery(tc, q)

	// NFR-6 fitness gate: refuse any SQL that lacks the static tenant predicate.
	// This is the enforced local backstop (injected projection is real-AWS only).
	if err := CheckTenantPredicate(sql, string(tc.TenantID)); err != nil {
		// Programmer error — buildColdQuery must always include the predicate.
		return kernel.SearchPage{}, fmt.Errorf("coldstore: fitness gate: %w", err)
	}

	startOut, err := s.realAthena.StartQueryExecution(ctx, &athena.StartQueryExecutionInput{
		QueryString: aws.String(sql),
		QueryExecutionContext: &athtypes.QueryExecutionContext{
			Database: aws.String(s.glueDB),
		},
		ResultConfiguration: &athtypes.ResultConfiguration{
			OutputLocation: aws.String(s.athenaResultBucket),
		},
		WorkGroup: aws.String(s.workgroup),
	})
	if err != nil {
		return kernel.SearchPage{}, fmt.Errorf("coldstore: start query: %w", err)
	}

	qid := aws.ToString(startOut.QueryExecutionId)
	if err := s.pollQuery(ctx, qid); err != nil {
		return kernel.SearchPage{}, err
	}

	return s.fetchResults(ctx, qid, q.Limit)
}

// pollQuery blocks until the Athena query reaches a terminal state or ctx is
// cancelled. The poll interval is 1 s with a generous timeout for large scans.
func (s *Store) pollQuery(ctx context.Context, qid string) error {
	const pollInterval = time.Second
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
		out, err := s.realAthena.GetQueryExecution(ctx, &athena.GetQueryExecutionInput{
			QueryExecutionId: aws.String(qid),
		})
		if err != nil {
			return fmt.Errorf("coldstore: get query execution: %w", err)
		}
		state := out.QueryExecution.Status.State
		switch state {
		case athtypes.QueryExecutionStateSucceeded:
			return nil
		case athtypes.QueryExecutionStateFailed:
			reason := ""
			if out.QueryExecution.Status.StateChangeReason != nil {
				reason = *out.QueryExecution.Status.StateChangeReason
			}
			return fmt.Errorf("coldstore: query failed: %s", reason)
		case athtypes.QueryExecutionStateCancelled:
			return errors.New("coldstore: query cancelled")
		}
		// QUEUED or RUNNING — keep polling.
	}
}

// fetchResults pages through Athena GetQueryResults and converts rows to
// kernel.LogEvents. The Athena result set always includes a header row as its
// first row, which is stripped before conversion.
func (s *Store) fetchResults(ctx context.Context, qid string, limit int) (kernel.SearchPage, error) {
	out, err := s.realAthena.GetQueryResults(ctx, &athena.GetQueryResultsInput{
		QueryExecutionId: aws.String(qid),
	})
	if err != nil {
		return kernel.SearchPage{}, fmt.Errorf("coldstore: get results: %w", err)
	}

	// Strip header row (col names) that Athena always prepends.
	rows := out.ResultSet.Rows
	if len(rows) > 0 {
		rows = rows[1:]
	}

	events := make([]kernel.LogEvent, 0, len(rows))
	for _, row := range rows {
		ev, err := rowToEvent(row)
		if err != nil {
			s.log.Warn("coldstore: row decode error (skipped)", "err", err)
			continue
		}
		events = append(events, ev)
	}

	if limit > 0 && len(events) > limit {
		events = events[:limit]
	}
	return kernel.SearchPage{Events: events}, nil
}

// rowToEvent converts an Athena result row to a LogEvent.
// Column order matches the SELECT in buildColdQuery: ts, id, service, level,
// message, labels.
func rowToEvent(row athtypes.Row) (kernel.LogEvent, error) {
	cells := row.Data
	str := func(i int) string {
		if i < len(cells) && cells[i].VarCharValue != nil {
			return *cells[i].VarCharValue
		}
		return ""
	}

	// ts is Unix millis (int64) stored as a string by Athena.
	tsMillis := str(0)
	var ts time.Time
	if tsMillis != "" {
		var ms int64
		if _, err := fmt.Sscanf(tsMillis, "%d", &ms); err == nil {
			ts = time.UnixMilli(ms).UTC()
		}
	}

	var labels map[string]string
	if labelsStr := str(5); labelsStr != "" && labelsStr != "{}" {
		if err := json.Unmarshal([]byte(labelsStr), &labels); err != nil {
			labels = nil // non-fatal; log omitted for brevity
		}
	}

	level := kernel.Level(str(3))

	return kernel.LogEvent{
		TS:      ts,
		ID:      str(1),
		Service: str(2),
		Level:   level,
		Message: str(4),
		Labels:  labels,
	}, nil
}

// ---------------------------------------------------------------------------
// Glue partition helpers
// ---------------------------------------------------------------------------

// gluePartition holds the three partition values for a cold batch.
type gluePartition struct {
	tenantID string
	dt       string // YYYY-MM-DD
	hour     string // 00..23
}

// createGluePartition registers a Hive-style partition in the Glue catalog
// for the given tenant/dt/hour triple. This is the explicit AddPartition path
// (cold-tier.md §3 fallback) that complements partition projection — belt-
// and-suspenders for immediate queryability.
//
// Returns nil if the partition already exists (idempotent).
func createGluePartition(ctx context.Context, g gluePartitioner, db, bucket string, p gluePartition) error {
	loc := fmt.Sprintf("s3://%s/logs/tenant_id=%s/dt=%s/hour=%s/",
		bucket, p.tenantID, p.dt, p.hour)

	cols := glueSchemaColumns()

	_, err := g.CreatePartition(ctx, &glue.CreatePartitionInput{
		DatabaseName: aws.String(db),
		TableName:    aws.String("log_events"),
		PartitionInput: &glutypes.PartitionInput{
			Values: []string{p.tenantID, p.dt, p.hour},
			StorageDescriptor: &glutypes.StorageDescriptor{
				Columns:  cols,
				Location: aws.String(loc),
				InputFormat: aws.String(
					"org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"),
				OutputFormat: aws.String(
					"org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"),
				SerdeInfo: &glutypes.SerDeInfo{
					SerializationLibrary: aws.String(
						"org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"),
					Parameters: map[string]string{"parquet.compression": "SNAPPY"},
				},
			},
		},
	})
	if err != nil {
		// AlreadyExistsException is idempotent — treat as success.
		if strings.Contains(err.Error(), "AlreadyExists") {
			return nil
		}
		return fmt.Errorf("glue CreatePartition: %w", err)
	}
	return nil
}

// glueSchemaColumns returns the Glue column list that mirrors cold-tier.md §2.
// This MUST match the Parquet schema in coldLogRecord exactly.
func glueSchemaColumns() []glutypes.Column {
	return []glutypes.Column{
		{Name: aws.String("tenant_id"), Type: aws.String("string")},
		{Name: aws.String("ts"), Type: aws.String("bigint")}, // Unix millis
		{Name: aws.String("id"), Type: aws.String("string")},
		{Name: aws.String("service"), Type: aws.String("string")},
		{Name: aws.String("level"), Type: aws.String("string")},
		{Name: aws.String("message"), Type: aws.String("string")},
		{Name: aws.String("labels"), Type: aws.String("string")},
		{Name: aws.String("trace_id"), Type: aws.String("string")},
		{Name: aws.String("span_id"), Type: aws.String("string")},
		{Name: aws.String("raw"), Type: aws.String("string")},
	}
}

// ---------------------------------------------------------------------------
// EnsureGlueTable — provisioning helper (NOT part of the ColdArchive port)
// ---------------------------------------------------------------------------

// EnsureGlueTable creates the Glue database + table with the cold-tier.md §3
// DDL (partition projection enabled, injected tenant_id, date/integer dt/hour)
// if they do not already exist. Idempotent.
//
// Call at startup in local dev / integration tests. In production the table is
// provisioned by Terraform (IaC concern, not the adapter's responsibility).
func EnsureGlueTable(ctx context.Context, g gluePartitioner, db, bucket string) error {
	// The gluePartitioner interface is too narrow for CreateTable — for this
	// helper we accept the full Glue client directly.
	gc, ok := g.(interface {
		CreateDatabase(context.Context, *glue.CreateDatabaseInput, ...func(*glue.Options)) (*glue.CreateDatabaseOutput, error)
		CreateTable(context.Context, *glue.CreateTableInput, ...func(*glue.Options)) (*glue.CreateTableOutput, error)
	})
	if !ok {
		return errors.New("coldstore: EnsureGlueTable: glue client does not implement CreateDatabase/CreateTable")
	}

	// Create the database if it doesn't exist.
	_, err := gc.CreateDatabase(ctx, &glue.CreateDatabaseInput{
		DatabaseInput: &glutypes.DatabaseInput{
			Name:        aws.String(db),
			Description: aws.String("Logalot cold-tier log archive (ADR-0005)"),
		},
	})
	if err != nil && !strings.Contains(err.Error(), "AlreadyExists") {
		return fmt.Errorf("coldstore: Glue CreateDatabase %q: %w", db, err)
	}

	locationTmpl := fmt.Sprintf(
		"s3://%s/logs/tenant_id=${tenant_id}/dt=${dt}/hour=${hour}/", bucket)

	projParams := map[string]string{
		"EXTERNAL":                    "TRUE",
		"projection.enabled":          "true",
		"projection.tenant_id.type":   "injected", // engine-enforced on real AWS Athena
		"projection.dt.type":          "date",
		"projection.dt.format":        "yyyy-MM-dd",
		"projection.dt.range":         "2026-01-01,NOW",
		"projection.dt.interval":      "1",
		"projection.dt.interval.unit": "DAYS",
		"projection.hour.type":        "integer",
		"projection.hour.range":       "0,23",
		"projection.hour.digits":      "2",
		"storage.location.template":   locationTmpl,
	}

	partKeys := []glutypes.Column{
		{Name: aws.String("tenant_id"), Type: aws.String("string")},
		{Name: aws.String("dt"), Type: aws.String("string")},
		{Name: aws.String("hour"), Type: aws.String("string")},
	}

	_, err = gc.CreateTable(ctx, &glue.CreateTableInput{
		DatabaseName: aws.String(db),
		TableInput: &glutypes.TableInput{
			Name:        aws.String("log_events"),
			Description: aws.String("Cold archive (Parquet + SNAPPY, partition projection)"),
			StorageDescriptor: &glutypes.StorageDescriptor{
				Columns:  glueSchemaColumns(),
				Location: aws.String("s3://" + bucket + "/logs/"),
				InputFormat: aws.String(
					"org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"),
				OutputFormat: aws.String(
					"org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"),
				SerdeInfo: &glutypes.SerDeInfo{
					SerializationLibrary: aws.String(
						"org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"),
					Parameters: map[string]string{"parquet.compression": "SNAPPY"},
				},
			},
			PartitionKeys: partKeys,
			TableType:     aws.String("EXTERNAL_TABLE"),
			Parameters:    projParams,
		},
	})
	if err != nil && !strings.Contains(err.Error(), "AlreadyExists") {
		return fmt.Errorf("coldstore: Glue CreateTable: %w", err)
	}
	return nil
}
