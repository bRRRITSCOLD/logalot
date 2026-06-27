# logalot

Self-hostable, multi-tenant logging platform: high-volume ingest, live tail,
full-text + structured search, dashboards, and alerting. See
[`docs/architecture/overview.md`](docs/architecture/overview.md) for the system
design.

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
(`FLOCI_STORAGE_MODE=hybrid`).

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
