import type { OAuthAuditEvent, OAuthAuditLogger } from '../../app/ports';

// ConsoleOAuthAuditLogger writes a single structured JSON line per event to
// stderr.  It is the production adapter for v1 — a proper sink (Kinesis,
// CloudWatch Logs, BigQuery) can be wired behind this port without changing the
// application core.  Failures are swallowed: audit logging must never abort the
// auth flow (logged to stderr as a best-effort fallback).
//
// Each line is a valid JSON object so it can be consumed by any log aggregator
// that understands JSON-per-line (e.g. CloudWatch, Datadog, Loki).
export class ConsoleOAuthAuditLogger implements OAuthAuditLogger {
  log(event: OAuthAuditEvent): void {
    try {
      process.stderr.write(
        `${JSON.stringify({
          type: 'oauth_audit',
          tenant_id: event.tenantId,
          user_id: event.userId,
          provider: event.provider,
          hashed_sub: event.hashedSub,
          outcome: event.outcome,
          ts: event.ts.toISOString(),
        })}\n`,
      );
    } catch {
      // Swallow: never let the logger crash the auth flow.
    }
  }
}
