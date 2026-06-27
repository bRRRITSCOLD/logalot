import { ValidationError } from './errors';
import { splitN } from './split';

// Refresh-token wire format (migration 000012): `lgr_<tenantId>_<tokenId>_<secret>`.
//   - tenantId  the tenant UUID — resolves the tenant so RLS is armed before the
//               token lookup (same chicken-and-egg resolution as API keys,
//               model.md §4.5). UUIDs contain no '_', so the split is unambiguous.
//   - tokenId   refresh_tokens.id (UUID) — the O(1) lookup target.
//   - secret    high-entropy random; only sha256(secret) is stored (token_hash).

export const REFRESH_PREFIX = 'lgr';
export const REFRESH_SEPARATOR = '_';
export const REFRESH_SECRET_BYTES = 32;

export interface ParsedRefreshToken {
  readonly tenantId: string;
  readonly tokenId: string;
  readonly secret: string;
}

export function assembleRefreshToken(tenantId: string, tokenId: string, secret: string): string {
  return [REFRESH_PREFIX, tenantId, tokenId, secret].join(REFRESH_SEPARATOR);
}

// parseRefreshToken validates shape only (prefix, field count, non-empty fields)
// and does NO I/O. Mirrors the API-key parser's SplitN semantics.
export function parseRefreshToken(raw: string): ParsedRefreshToken {
  const parts = splitN(raw, REFRESH_SEPARATOR, 4);
  if (parts.length !== 4) {
    throw new ValidationError('malformed refresh token');
  }
  const [prefix, tenantId, tokenId, secret] = parts;
  if (prefix !== REFRESH_PREFIX || !tenantId || !tokenId || !secret) {
    throw new ValidationError('malformed refresh token');
  }
  return { tenantId, tokenId, secret };
}
