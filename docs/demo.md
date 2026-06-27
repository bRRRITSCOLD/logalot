# Logalot vertical-slice demo — ingest → store → live tail

This is the copy-paste demo for the first vertical slice (issue #9): a log POSTed
for a tenant appears in that tenant's live tail within 2s, is persisted in the hot
store under the tenant, and never crosses to another tenant. It runs the three Go
services (`ingest-service`, `processor`, `query-service`) on top of the infra
stack via `docker compose`.

- **Ingest:** `POST /v1/ingest` (Gin) → validate → publish to RabbitMQ (202 only
  after a durable publisher confirm).
- **Processor:** consume → normalize → persist to Postgres `log_events` under the
  tenant's RLS context → fan out to `tail:{tenant_id}` (Redis pub/sub).
- **Live tail:** `GET /v1/tail` (SSE) streams the authed tenant's new events.

The tenant is always derived from the **API key**, never the request body.

---

## 0. Prerequisites & the burrow port workaround

Docker + the repo. Create your `.env` (first `make` does this automatically):

```bash
cp .env.example .env
```

> **This host runs a `burrow` stack** that already binds the standard ports
> `5672` (RabbitMQ), `6379` (Redis), `15672`, and `27017` (Mongo). The slice
> services talk to the infra over the compose network by service hostname, so
> only the **host-published** ports clash. Move them in `.env` to dodge the clash
> (Postgres `5432` and the service ports `8080/8081` are free here):

```bash
# in .env — uncomment / set these if 5672/6379 are taken on the host:
REDIS_PORT=6380
RABBITMQ_PORT=5673
RABBITMQ_MGMT_PORT=15673
```

Postgres on `5432` is free on this host, so `POSTGRES_PORT` needs no change.

---

## 1. Bring up the slice

```bash
make slice-up
```

This brings up `postgres`/`redis`/`rabbitmq` (waiting for healthchecks), applies
all migrations, loads the dev seed (tenant `dev` + an API key), then builds and
starts the three services. When it returns you'll see:

```
slice up. ingest -> http://localhost:8080 | query -> http://localhost:8081
dev API key: lgk_dev_devkey001_devsecret0123456789  (see docs/demo.md)
```

The dev API key (DEV ONLY) is minted by `migrations/seeds/dev_tenant.sql`:

```
lgk_dev_devkey001_devsecret0123456789
```

Follow the service logs in another terminal if you want:

```bash
make slice-logs
```

---

## 2. The live demo (two terminals)

**Terminal A — open the live tail (SSE):**

```bash
curl -N \
  -H "Authorization: Bearer lgk_dev_devkey001_devsecret0123456789" \
  -H "Accept: text/event-stream" \
  http://localhost:8081/v1/tail
```

It stays open and prints `: keepalive` heartbeats.

**Terminal B — POST a log:**

```bash
curl -i -X POST http://localhost:8080/v1/ingest \
  -H "Authorization: Bearer lgk_dev_devkey001_devsecret0123456789" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello from the slice","level":"info","service":"demo","labels":{"region":"us-east-1"}}'
```

Expected: `HTTP/1.1 202 Accepted` with `{"accepted":1}`.

Back in **Terminal A**, within ~2s a `data:` frame appears:

```
data: {"tenant_id":"00000000-0000-0000-0000-0000000000d1","ts":"...","id":"...","service":"demo","level":"info","message":"hello from the slice","labels":{"region":"us-east-1"},"raw":{...}}
```

### One-shot scripted version

```bash
make slice-demo
```

It opens the tail, POSTs a canary log, and asserts it arrives within 2s.

---

## 3. Negative checks (auth)

Unauthenticated ingest is rejected `401`:

```bash
curl -i -X POST http://localhost:8080/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{"message":"no key"}'
# HTTP/1.1 401 Unauthorized
```

A malformed / unknown key is also `401`:

```bash
curl -i -X POST http://localhost:8080/v1/ingest \
  -H "Authorization: Bearer lgk_dev_devkey001_wrongsecret" \
  -H "Content-Type: application/json" \
  -d '{"message":"bad key"}'
# HTTP/1.1 401 Unauthorized
```

---

## 4. The isolation lock (automated, hermetic)

The cross-tenant guarantee — *a log for tenant A never appears in tenant B's tail
or rows* — is locked by the e2e test, which spins its own Postgres/Redis/RabbitMQ
in **random-port testcontainers** (so it is unaffected by the burrow stack) and
runs the real service binaries:

```bash
make slice-test
# or: cd tests/e2e && go test -tags=e2e -run TestSliceE2E -v ./...
```

It proves, with two seeded tenants and minted keys, that A's event reaches A's
tail in <2s and is persisted under A, while B sees **zero** tail frames and
**zero** rows over a 3s drain window — plus the `401` auth rejections above.

---

## 5. Tear down

```bash
make slice-down       # stop services + infra (keeps data volumes)
make reset            # also wipe the named volumes (destructive)
```
