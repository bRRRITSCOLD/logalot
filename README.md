# logalot

Self-hostable, multi-tenant logging platform: high-volume ingest, live tail,
full-text + structured search, dashboards, and alerting. See
[`docs/architecture/overview.md`](docs/architecture/overview.md) for the system
design.

## Monorepo layout

Logalot is a polyglot monorepo. Go services share a Go workspace (`go.work`);
Node services and the frontend share a pnpm workspace (`pnpm-workspace.yaml`).

```
pkg/kernel/        shared Go module (TenantContext + ports, issue #4)
services/          backend services — Go (go.mod) AND Node (package.json)
  ingest-service/  Go + Gin        (#6)
  processor/       Go worker       (#7)
  query-service/   Go + SSE        (#8)
  control-plane/   Node + Fastify  (#11)
apps/web/          TanStack Start frontend + BFF (#20)
tools/             repo tooling + scaffold packages
docs/  migrations/  architecture, ADRs, data model, SQL
```

Build, test, and lint everything with `make`:

```sh
make test    # all Go + Node tests       (CI runs the same targets)
make lint    # all Go + Node lint/format checks
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for where a new service/app goes,
Conventional Commits, and the squash-merge workflow.

## Local stack

`logalot` runs entirely on Docker for local development. One `docker-compose.yml`
brings up the full data plane, every service reads a single `.env`, and a
`Makefile` wraps the common commands.

### Prerequisites

You need only these on the host — nothing else:

- Docker Engine with the Compose plugin (`docker compose`)
- `make`

That's it. Postgres, Redis, RabbitMQ, MongoDB, and floci all run in containers;
no client tooling needs to be installed locally.

### Bring it up

```sh
make up      # creates .env from .env.example on first run, then starts the stack
make ps      # show service status — wait until all five report "healthy"
```

`make up` copies `.env.example` to `.env` automatically the first time. Edit
`.env` if you want to change credentials or ports; every service reads from it.

### Services

After `make up`, the stack exposes (default `.env` ports):

| Service  | Purpose                                        | Host endpoint            | Default creds (`.env`)        |
|----------|------------------------------------------------|--------------------------|-------------------------------|
| postgres | Control plane + hot log store (ADR-0003)       | `localhost:5432`         | `logalot` / `logalot`         |
| redis    | Tail pub/sub, key cache, rate limit            | `localhost:6379`         | password `logalot`            |
| rabbitmq | Ingest pipeline + DLQ (AMQP)                   | `localhost:5672`         | `logalot` / `logalot`         |
| rabbitmq | Management UI                                  | http://localhost:15672   | `logalot` / `logalot`         |
| mongodb  | Reserved/unused, present per ADR-0003          | `localhost:27017`        | `logalot` / `logalot`         |
| floci    | AWS-local: S3, Firehose, Athena/Glue, SNS/SQS  | http://localhost:4566    | dummy AWS creds (`test`)      |

Quick reachability checks:

```sh
# postgres
docker exec logalot-postgres pg_isready -U logalot -d logalot
# redis
docker exec logalot-redis redis-cli -a "$REDIS_PASSWORD" ping     # -> PONG
# rabbitmq management UI
open http://localhost:15672                                        # login logalot/logalot
# floci (AWS-local)
curl -s http://localhost:4566/_floci/health
```

floci is the AWS emulator (not LocalStack). Point AWS SDK clients at
`AWS_ENDPOINT_URL=http://localhost:4566` with the dummy creds from `.env`.
Inside the Docker network, services reach floci-issued URLs via the hostname
`floci` (`FLOCI_HOSTNAME`); state persists to a named volume
(`FLOCI_STORAGE_MODE=hybrid`). floci mounts the host Docker socket
(`/var/run/docker.sock`) so it can launch container-backed AWS services
(Athena/Glue) — this grants floci host-Docker access and is **local-dev-only**;
never run this compose file on a shared or production host.

### Managing the stack

| Command      | What it does                                                     |
|--------------|-----------------------------------------------------------------|
| `make up`    | Start all services in the background                             |
| `make ps`    | Show status + health                                             |
| `make logs`  | Tail logs from all services                                     |
| `make down`  | Stop and remove containers (volumes kept)                       |
| `make reset` | Stop everything and **wipe all volumes** (destructive)          |

### Database migrations & seed

Schema migrations use [golang-migrate](https://github.com/golang-migrate/migrate)
run through Docker (no host install). With the stack up:

| Command               | What it does                                                  |
|-----------------------|--------------------------------------------------------------|
| `make migrate-up`     | Apply all pending migrations                                  |
| `make migrate-down`   | Roll back exactly one migration                              |
| `make migrate-version`| Print the current schema version                            |
| `make migrate-create name=...` | Scaffold a new `.up.sql`/`.down.sql` pair          |
| `make seed`           | Load the dev tenant + admin + API key (idempotent)          |

```sh
make up
make migrate-up        # applies 000001..000011
make seed              # dev tenant + key lgk_dev_devkey001_devsecret0123456789
```

**Two Postgres roles, two connection strings.** Migrations and `make seed` run as
the **admin** role (`DATABASE_URL`), which owns the schema. Every *service*
connects as **`logalot_app`** (`LOGALOT_APP_DATABASE_URL`) — a `NOSUPERUSER`,
non-`BYPASSRLS` role provisioned by migration `000011`. That separation is what
makes `FORCE ROW LEVEL SECURITY` actually enforce tenant isolation; a service
must never use the admin URL. See
[`docs/data/migration-plan.md §2`](docs/data/migration-plan.md) and
[`docs/data/model.md §4.2`](docs/data/model.md).
