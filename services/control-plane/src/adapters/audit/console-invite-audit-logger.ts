import type { InviteAuditEvent, InviteAuditLogger } from '../../app/ports';

// ConsoleInviteAuditLogger writes a single structured JSON line per event to
// stderr. It is the production adapter for v1 — a proper sink can be wired
// behind this port without changing the application core. Failures are
// swallowed: audit logging must never abort the invite lifecycle flow.
//
// Each line is a valid JSON object consumable by any JSON-per-line log
// aggregator (CloudWatch, Datadog, Loki, etc.).
//
// Privacy-safe: the token plaintext and secret hash are NEVER logged — only
// the invite id, actor id, outcome, normalized email, and role (R-INV-9).
export class ConsoleInviteAuditLogger implements InviteAuditLogger {
  log(event: InviteAuditEvent): void {
    try {
      process.stderr.write(
        `${JSON.stringify({
          type: 'invite_audit',
          tenant_id: event.tenantId,
          invite_id: event.inviteId,
          actor_id: event.actorId,
          outcome: event.outcome,
          email: event.email,
          role: event.role,
          ts: event.ts.toISOString(),
        })}\n`,
      );
    } catch {
      // Swallow: never let the logger crash the invite flow.
    }
  }
}
