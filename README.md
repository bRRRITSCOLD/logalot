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
| `make seed`  | Placeholder — migrate + seed runner lands in issue #3           |

> Database migrations and the dev seed (the `logalot_app` role + golang-migrate
> runner) are not part of this stack; they arrive in issue #3.
