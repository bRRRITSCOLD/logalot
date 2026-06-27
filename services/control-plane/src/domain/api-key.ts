import { ValidationError } from './errors';
import { sha256 } from './secret-hash';
import { splitN } from './split';

// API-key format + hashing — the LOAD-BEARING compatibility contract with the Go
// ingest Authenticator (pkg/auth/key.go, pkg/auth/issue.go) and migration 000005.
//
// A key is `lgk_<publicId>_<keyId>_<secret>`:
//   - publicId  the tenant slug (tenants.public_id) — resolves the tenant so RLS
//               is armed before the scoped key lookup.
//   - keyId     api_keys.id — the O(1) primary-key lookup target.
//   - secret    high-entropy random; only SHA-256(secret) is ever stored.
//
// Stored: { id=keyId, tenant_id, key_hash = sha256(secret) (32 raw bytes) }.
// A key minted here MUST authenticate via the Go side, so the bytes must match
// exactly: same prefix, same separator, same digest, same component sizes.

export const KEY_PREFIX = 'lgk';
export const KEY_SEPARATOR = '_';

// Random component sizes, in bytes, matching pkg/auth/issue.go (keyIDBytes=16,
// secretBytes=32). Hex-encoded so neither component can contain the separator.
export const KEY_ID_BYTES = 16;
export const SECRET_BYTES = 32;

export interface KeyMaterial {
  readonly keyId: string;
  readonly secret: string;
}

export interface MintedApiKey {
  readonly keyId: string;
  readonly secret: string;
  // The full one-time plaintext credential shown to the admin exactly once.
  readonly plaintext: string;
  // sha256(secret) as 32 raw bytes — exactly what is stored in api_keys.key_hash.
  readonly keyHash: Buffer;
}

export interface ParsedApiKey {
  readonly publicId: string;
  readonly keyId: string;
  readonly secret: string;
}

// hashSecret is the api-key alias of the shared sha256 helper, kept for intent at
// call sites and so mint/verify (here and on the Go side) can never diverge.
export function hashSecret(secret: string): Buffer {
  return sha256(secret);
}

// assemblePlaintext joins the four logical fields into the wire credential.
export function assemblePlaintext(publicId: string, material: KeyMaterial): string {
  return [KEY_PREFIX, publicId, material.keyId, material.secret].join(KEY_SEPARATOR);
}

// mintApiKey is the pure minting function: given a tenant slug and freshly
// generated random material (injected for testability), it produces the one-time
// plaintext plus the hash to persist. Randomness generation is an adapter concern
// (KeyMaterialGenerator) so the domain stays deterministic and unit-testable.
export function mintApiKey(publicId: string, material: KeyMaterial): MintedApiKey {
  return {
    keyId: material.keyId,
    secret: material.secret,
    plaintext: assemblePlaintext(publicId, material),
    keyHash: hashSecret(material.secret),
  };
}

// parseApiKey deconstructs a presented credential, validating shape only. Mirrors
// Go parseKey's SplitN(raw, "_", 4): the secret is the final remainder. No I/O.
export function parseApiKey(raw: string): ParsedApiKey {
  const parts = splitN(raw, KEY_SEPARATOR, 4);
  if (parts.length !== 4) {
    throw new ValidationError('malformed api key');
  }
  const [prefix, publicId, keyId, secret] = parts;
  if (prefix !== KEY_PREFIX || !publicId || !keyId || !secret) {
    throw new ValidationError('malformed api key');
  }
  return { publicId, keyId, secret };
}
