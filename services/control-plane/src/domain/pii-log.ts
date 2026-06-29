import { createHash } from 'node:crypto';

// piiHash returns the first 8 hex characters of SHA-256(value).
//
// Purpose: log-safe PII identification.  A raw email or Google `sub` must never
// appear in structured logs (NFR-5 / ADR-0007).  piiHash produces a short,
// stable fingerprint that lets you correlate log lines for the same identity
// without exposing the underlying PII.
//
// 8 hex chars = 32 bits of output — suitable for log correlation (low enough
// collision probability across millions of events to be useful).  Note: this is
// an UNSALTED hash, so a known or guessable input (e.g. a common corporate
// email address) CAN be confirmed by a dictionary/rainbow-table lookup if logs
// are stolen.  The digest is intentionally sized for correlation, not
// confidentiality — it is not a substitute for encryption or access controls on
// the log store itself.
//
// Usage:
//   req.log.info({ subHash: piiHash(claims.sub) }, 'oidc callback: identity resolved')
export function piiHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}
