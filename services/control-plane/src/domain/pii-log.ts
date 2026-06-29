import { createHash } from 'node:crypto';

// piiHash returns the first 8 hex characters of SHA-256(value).
//
// Purpose: log-safe PII identification.  A raw email or Google `sub` must never
// appear in structured logs (NFR-5 / ADR-0007).  piiHash produces a short,
// stable fingerprint that lets you correlate log lines for the same identity
// without exposing the underlying PII.
//
// 8 hex chars = 32 bits of output — low enough collision risk for log
// correlation across millions of events, high enough not to be brute-forced
// into the original email in a log-theft scenario.
//
// Usage:
//   req.log.info({ subHash: piiHash(claims.sub) }, 'oidc callback: identity resolved')
export function piiHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}
