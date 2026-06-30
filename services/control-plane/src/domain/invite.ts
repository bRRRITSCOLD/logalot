import { ValidationError } from './errors';
import { sha256 } from './secret-hash';
import { splitN } from './split';

// Invite-token format: `lginv_<publicId>_<secret>`
//   - publicId  the tenant slug — identifies the tenant the invite belongs to.
//   - secret    256-bit CSPRNG random; only sha256(secret) is ever stored
//               (invite_secret_hash). The plaintext is shown exactly once.
//
// Format uses three components (SplitN(..., 3)) so a '_' inside the secret is
// preserved as the remainder — same semantics as splitN for API keys / refresh
// tokens, but without an intermediate id field since invites are looked up by
// the publicId + hash alone.

export const INVITE_PREFIX = 'lginv';
export const INVITE_SEPARATOR = '_';

// INVITE_SECRET_BYTES matches STATE_BYTES (256-bit), consistent with ADR-0007:
// high-entropy randoms hash with plain SHA-256, not a KDF.
export const INVITE_SECRET_BYTES = 32;

// InviteToken is the one-time plaintext value object. It is ONLY produced at
// invite creation and must never be reconstructed from stored state (the stored
// row holds only the hash). Named explicitly so call sites cannot accidentally
// pass an Invite (the metadata projection) where the secret is required.
export interface InviteToken {
  readonly publicId: string;
  readonly secret: string;
  // The full one-time plaintext credential shown to the inviter exactly once.
  readonly plaintext: string;
}

export interface ParsedInviteToken {
  readonly publicId: string;
  readonly secret: string;
}

// hashInviteSecret returns SHA-256 of the invite secret as 32 raw bytes — the
// single value stored in invites.secret_hash. Reuses domain/secret-hash.ts;
// no new primitive (R-INV-2). Must stay byte-identical to any Go verification.
export function hashInviteSecret(secret: string): Buffer {
  return sha256(secret);
}

// assembleInviteToken joins the three logical fields into the wire credential.
export function assembleInviteToken(publicId: string, secret: string): string {
  return [INVITE_PREFIX, publicId, secret].join(INVITE_SEPARATOR);
}

// parseInviteToken deconstructs a presented invite token, validating shape
// only. Uses splitN(raw, '_', 3) so any '_' inside the secret is preserved
// as the remainder. Throws ValidationError on malformed input.
export function parseInviteToken(raw: string): ParsedInviteToken {
  const parts = splitN(raw, INVITE_SEPARATOR, 3);
  if (parts.length !== 3) {
    throw new ValidationError('malformed invite token');
  }
  const [prefix, publicId, secret] = parts;
  if (prefix !== INVITE_PREFIX || !publicId || !secret) {
    throw new ValidationError('malformed invite token');
  }
  return { publicId, secret };
}

// mintInviteToken is the pure minting function: given a tenant slug and a
// freshly generated secret (injected for testability), it produces the
// one-time plaintext InviteToken value object. Callers must generate the
// secret from INVITE_SECRET_BYTES of CSPRNG output (hex-encoded).
export function mintInviteToken(publicId: string, secret: string): InviteToken {
  return {
    publicId,
    secret,
    plaintext: assembleInviteToken(publicId, secret),
  };
}
