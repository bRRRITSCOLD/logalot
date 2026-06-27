import { randomBytes, randomUUID } from 'node:crypto';
import { REFRESH_SECRET_BYTES } from '../../domain/refresh-token';
import type { IdGenerator, SecretGenerator } from '../../app/ports';

// NodeSecretGenerator yields a high-entropy hex secret for refresh tokens, sized
// to match REFRESH_SECRET_BYTES. Hex so it never contains the '_' separator.
export class NodeSecretGenerator implements SecretGenerator {
  generate(): string {
    return randomBytes(REFRESH_SECRET_BYTES).toString('hex');
  }
}

// NodeIdGenerator yields UUIDs (refresh-token family ids) via the CSPRNG.
export class NodeIdGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }
}
