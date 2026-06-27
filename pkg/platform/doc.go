// Package platform holds the tiny, framework-free constructors every Logalot Go
// service shares: a pgx connection pool and a go-redis client, each wired from
// the same environment variables docker-compose and .env define.
//
// It is deliberately minimal (KISS): no DI container, no config framework, no
// lifecycle manager. Services call NewPool / NewRedisClient at startup, defer
// Close, and inject the result into their adapters (e.g. pkg/auth). Keeping this
// in one shared module means ingest-service (#6), processor (#7) and
// query-service (#8) do not each re-implement pool/redis construction (DRY).
package platform
