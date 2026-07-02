# alert-evaluator

The Alerting context's **evaluation worker** (ADR-0001). On a schedule it:

1. finds **due** alert rules across all tenants (rule metadata only),
2. counts each rule's matching `log_events` over its rolling window **under that
   rule's per-tenant RLS context**,
3. transitions the rule's state (`ok` ⇄ `firing`), and
4. dispatches **exactly one notification per transition**.

Rule **CRUD** lives in the `control-plane` (Node+Fastify); this service only
evaluates. Anomaly/ML detection and the alert UI are out of scope (waves 4+).

## The tenant-isolation boundary (load-bearing)

Per `docs/data/model.md §4.5`, the evaluator holds **two database connections on
two roles** and never crosses them:

| Port | Role | Grants | Reads |
|------|------|--------|-------|
| `RuleStore` (scheduling metadata) | `logalot_evaluator` (**BYPASSRLS**) | `alert_rules`, `alert_notifications` only | rule metadata + query definition across all tenants |
| `LogCounter` (log content) | `logalot_app` (**NOSUPERUSER, NOBYPASSRLS**) | per migration 000011 | `log_events` **only** under `SET LOCAL app.tenant_id` |

The BYPASSRLS scheduler role is granted **nothing** on `log_events`, so it cannot
read log content even though it bypasses RLS — a `SELECT` fails *permission
denied*. Log content is read exclusively by the RLS-governed `logalot_app` role
with the rule's tenant armed. This is proven by the integration test.

## Exactly-once notification per transition

`alert_rules.transition_seq` is bumped on every state change; the state change is a
**compare-and-swap** (`UPDATE … WHERE state = <expected>`), and the
`alert_notifications` outbox row is inserted in the **same transaction** with
`UNIQUE (rule_id, transition_seq)`. So:

- a rule that stays `firing` across many cycles **never re-notifies** (no spam),
- the clear (`firing → ok`) emits exactly one **resolved** notification,
- two racing evaluators emit **one** notification (the CAS serializes them).

## Notifiers (pluggable behind the `Notifier` port)

- `logsink` (default): records + logs each notification — auditable, no external
  dependency; also the test double.
- `sns`: publishes to floci/AWS **SNS**, which fans out to **SQS / webhook**
  subscriptions. Point `AWS_ENDPOINT_URL` at floci (`:4566`).

Either base notifier can be wrapped with **`EmailNotifier`** (issue #187), which
sends a real email over **SMTP** for every channel of type `email` — retiring the
old SNS email-stub. It is enabled independently of `ALERT_NOTIFIER` whenever
`SMTP_HOST` is set: the base notifier still runs unchanged (so `webhook` channels
are unaffected), and `email` channels are additionally delivered via
`SMTPEmailSender` (the same adapter pattern as the invites context's SMTP sender in
`control-plane`). Locally it points at the shared **MailHog** container
(`docker-compose.yml`); verify delivery at `http://localhost:8025`.

## Configuration

| Env | Required | Default | Notes |
|-----|----------|---------|-------|
| `LOGALOT_EVALUATOR_DATABASE_URL` | yes | — | BYPASSRLS `logalot_evaluator` DSN |
| `LOGALOT_APP_DATABASE_URL` | yes | — | RLS `logalot_app` DSN |
| `ALERT_EVAL_INTERVAL` | no | `10s` | must be `>0` and `<30s` (NFR) |
| `ALERT_EVAL_BATCH_SIZE` | no | `200` | rules drained per cycle |
| `ALERT_NOTIFIER` | no | `logsink` | `logsink` \| `sns` |
| `ALERT_SNS_TOPIC_ARN` | if `sns` | — | destination topic |
| `AWS_ENDPOINT_URL` | no | — | floci endpoint for SNS |
| `SMTP_HOST` | no | — | setting this enables real `email`-channel send |
| `SMTP_PORT` | if `SMTP_HOST` | — | e.g. `1025` for MailHog |
| `SMTP_FROM` | if `SMTP_HOST` | — | fixed envelope/header From address |
| `SMTP_USER` / `SMTP_PASS` | no | — | omit for unauthenticated relays (MailHog) |

## Tests

```sh
go test ./...                     # unit (Docker-free)
go test -tags=integration ./...   # + testcontainers postgres + floci SNS/SQS
```

Integration tests use **random-port** testcontainers (the host `burrow` stack
occupies the standard ports) and are gated behind the `integration` build tag so
the default CI stays unit-only — matching the processor/query-service convention.
