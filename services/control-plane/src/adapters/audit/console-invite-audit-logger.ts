import type { InviteAuditEvent, InviteAuditLogger } from '../../app/ports';

// ConsoleInviteAuditLogger writes a single structured JSON line per event to
// stderr. Mirrors ConsoleOAuthAuditLogger: one JSON-per-line sink compatible
// with any log aggregator (CloudWatch, Datadog, Loki). Failures are swallowed —
// audit logging must never abort the invite flow (ADR-0012, R-INV-9).
//
// Privacy invariant: the log line carries the invite id and actor id, but NEVER
// the token, token hash, or the one-time inviteUrl (R-INV-9).
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
