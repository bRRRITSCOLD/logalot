# ADR-0013: Invite email delivery abstraction (`EmailSender`)

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** systems architect (+ security-architect on the token-bearing channel, ops on provider config)
- **Related:** spec [2026-06-30-user-invites-design](../superpowers/specs/2026-06-30-user-invites-design.md),
  ADR-0012 (the consumer — invite create returns the link; email is the optional second channel),
  ADR-0010 (SSM secrets — provider credentials), ADR-0009 (single-box AWS topology, compose),
  **[threat-model-user-invites](../security/threat-model-user-invites.md) (R-INV-1) — the email carries the one-time link**

## Context

ADR-0012 creates invites and **always returns the one-time link** in the create response (shown once). Sending
that link by email is a **convenience, not a dependency**: an admin can copy the link out of the UI and deliver
it however they like. We still want first-class email delivery when an operator configures a provider, and a
working local dev loop, without (a) coupling invite creation to an email service's availability, or (b) leaking
provider secrets into the HTTP/auth layers.

Forces:
- **Optionality.** Many environments (dev, test, a bare PoC) have no mail provider. Email must be **gated by
  config** with a safe no-op fallback; its absence must never fail a create.
- **Decoupling.** The `invites` row is the source of truth and is committed before any send. An email-provider
  outage, throttle, or misconfiguration must **not** roll back or fail the create — the link is already in the
  response.
- **Secret hygiene.** SMTP/SES credentials are secrets (ADR-0010, SSM SecureString). Only the sending adapter
  may see them — mirroring how the Google `client_secret` is confined to the exchange adapter (ADR-0008).
- **Token-bearing channel.** The email body contains the one-time invite link (the token). The send path must
  **never log** the link/token, and the design leans on ADR-0012's email-binding (R-INV-1) to bound the blast
  radius of an intercepted message.
- **Local dev parity.** The team uses floci for AWS-local; the email loop needs an equivalent local catcher so
  developers can *see* the rendered invite without a real provider.

## Decision

### `EmailSender` port — thin, one method, gated by `EMAIL_PROVIDER`

A new optional driven port in the control-plane application core:

```
interface EmailSender {
  send(message: EmailMessage): Promise<void>;  // { to, subject, text/html (rendered invite link) }
}
```

The composition root (`container.ts`) selects the adapter from `EMAIL_PROVIDER`:

- **unset / `none`** → `NoOpEmailSender`: logs that delivery was skipped (metadata only — recipient + invite id,
  **never** the link/token) and returns. This is the default for dev/test/PoC.
- **`smtp`** → `SmtpEmailSender` (nodemailer to the configured SMTP host). Works against MailHog locally and any
  SMTP relay — including Amazon SES's SMTP interface — in production.
- **`ses`** → reserved adapter slot behind the same port for the AWS SES SDK (bounce/complaint events), added
  only if/when those features are wanted. **Not built now** (YAGNI).

The port lives in the app layer; provider secrets are injected into the adapter only, read from SSM via the
instance profile (ADR-0010). The HTTP/auth layers never see them.

### Create succeeds and returns the link even if email fails or is unconfigured — the rule

`InviteService.create` (ADR-0012):

1. Generates the token, writes the `invites` row (`token_hash`), and **assembles the link** — this is the
   committed source of truth.
2. Returns `{ invite, inviteUrl }` with the plaintext token (shown once) **before** delivery is guaranteed.
3. Dispatches the email as a **best-effort** step: render → `EmailSender.send`. A `send` rejection (provider
   down, throttled, misconfigured) or the `NoOpEmailSender` is **caught and audited, never propagated** — the
   create has already succeeded and the link is already in the response.

This mirrors the codebase's existing "non-fatal side effect" patterns: the fire-and-forget `touchLastLogin` and
the audit-logger-never-aborts-the-flow rule in `oidc-authenticator.ts`. Delivery is decoupled from the
transaction; the link is the contract, email is the convenience.

### SMTP-first; SES is a later adapter behind the same port

Ship the **`smtp` adapter + `NoOp`** now. SES-native is deferred. Rationale:

- **Provider-agnostic reach (DRY).** One SMTP adapter covers MailHog (local), SES-SMTP, Mailgun, Postfix, and
  any transactional relay — the broadest coverage from a single implementation.
- **Local dev parity at $0.** SMTP + MailHog gives a real, inspectable dev loop (see the rendered invite in the
  MailHog UI) with no cloud dependency, matching the floci-for-AWS-local philosophy.
- **SES-native earns its slot later, not now.** The SES SDK adds value only for bounce/complaint event handling
  and sending-reputation features we do not need for a PoC. SES also requires domain verification and a
  sandbox-exit before it can send to arbitrary recipients — operational friction that SMTP-first sidesteps,
  while still letting production point the SMTP adapter *at* SES-SMTP when desired.
- **Cost is not the deciding factor.** SES from EC2 is effectively free at PoC volume (generous free tier); the
  decision is driven by flexibility + local parity, not price.

### Local dev — MailHog mail catcher

Add a **MailHog** container to the dev compose (SMTP `:1025`, web UI `:8025`); set `EMAIL_PROVIDER=smtp` pointed
at it. Developers exercise the full create→email path and inspect the rendered invite without a real provider
and without sending to real inboxes.

### Security of the token-bearing channel

The email body carries the one-time link. The send path **must not log** the link or token (only recipient +
invite id metadata). The residual risk of an intercepted email is bounded by ADR-0012's **email-binding**
(R-INV-1): the intercepted link cannot onboard a different Google account. Provider credentials follow ADR-0010
(SSM, instance-profile, adapter-only). See the separately-authored threat model for the full treatment.

## Status

Accepted. `EmailSender` port gated by `EMAIL_PROVIDER`; `NoOp` default + `smtp` adapter shipped; `ses` is a
reserved slot behind the same port. Invite create always returns the link; email is best-effort and never fails
the create. MailHog is the local catcher.

## Consequences

### Positive
- **Invite creation never depends on email.** The link is the contract; a mail outage degrades to copy-paste,
  not failure.
- **One adapter, broadest reach.** SMTP covers local (MailHog) through production (SES-SMTP / any relay) without
  bespoke per-provider code; SES-native remains a clean future slot behind the same port.
- **Secret confinement preserved.** Provider creds live in the adapter + SSM only, exactly like the Google
  `client_secret` — HTTP/auth layers stay secret-free.
- **Real local loop at $0.** MailHog lets developers see the rendered invite end-to-end.

### Negative / costs
- **No native bounce/complaint handling** under SMTP-first; undeliverable invites fail silently (the admin still
  has the link in the UI). Acceptable for a PoC; the `ses` slot is the upgrade path.
- **Best-effort delivery means an admin can believe an email was sent when the provider silently dropped it.**
  Mitigated by auditing send outcome and by always surfacing the copyable link in the UI.
- **Another optional config surface** (`EMAIL_PROVIDER` + SMTP/SES params) to document and wire through SSM.

### Trigger to revisit
- **Bounce/complaint visibility or sending-reputation management** becomes a requirement → build the `ses`
  adapter behind the existing port.
- **Delivery guarantees** (retries, dead-letter) are needed → move dispatch onto the existing RabbitMQ transport
  (ADR-0004) with a worker, instead of in-request best-effort.

## Alternatives considered

| Concern | Chosen | Alternative | Why chosen |
|---|---|---|---|
| Delivery vs create coupling | **Link always returned; email best-effort, never fails create** | Email send inside the create transaction (create fails if email fails) | The row is the source of truth; coupling create to a third-party send makes onboarding brittle and the link is already in the response |
| First provider adapter | **SMTP (nodemailer)** + `NoOp` default | SES SDK first | One SMTP adapter spans MailHog→SES-SMTP→any relay (DRY); SES sandbox/verification friction and its SDK-only features aren't needed for a PoC |
| Provider selection | **`EMAIL_PROVIDER` config gate + `NoOp` fallback** | Always-on, require a provider | Dev/test/PoC have no provider; absence must be a safe no-op, not a hard dependency |
| Secret handling | **Adapter-only, SSM-backed (ADR-0010)** | Provider creds in app/env passed through layers | Confine secrets to the sender, mirroring the Google `client_secret` boundary (ADR-0008) |
| Local dev mail | **MailHog container** in compose | Hit a real provider in dev / log-only | Inspectable end-to-end loop at $0, no real sends, matches the floci-local philosophy |
