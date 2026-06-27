package platform

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

// AppDatabaseURLEnv is the environment variable every service reads for its
// Postgres connection. It MUST point at the NOSUPERUSER `logalot_app` role (see
// .env.example LOGALOT_APP_DATABASE_URL) so FORCE ROW LEVEL SECURITY governs the
// connection — never the migrate/admin role.
const AppDatabaseURLEnv = "LOGALOT_APP_DATABASE_URL"

// AppDatabaseURL returns the application Postgres DSN from the environment, or an
// error if it is unset. Fail closed: a service with no configured app DSN must
// not silently fall back to anything privileged.
func AppDatabaseURL() (string, error) {
	dsn := os.Getenv(AppDatabaseURLEnv)
	if dsn == "" {
		return "", fmt.Errorf("platform: %s is not set", AppDatabaseURLEnv)
	}
	return dsn, nil
}

// NewPool opens a pgx connection pool for dsn and verifies connectivity with a
// ping before returning. The caller owns the pool and MUST Close it. dsn is
// expected to be the logalot_app role DSN (see AppDatabaseURL).
func NewPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("platform: parse postgres dsn: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("platform: open postgres pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("platform: ping postgres: %w", err)
	}
	return pool, nil
}
