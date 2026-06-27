import { randomBytes } from 'node:crypto';
import type { KeyMaterialGenerator } from '../../app/ports';
import { KEY_ID_BYTES, type KeyMaterial, SECRET_BYTES } from '../../domain/api-key';

// NodeKeyMaterialGenerator produces the random keyId + secret for a new API key
// using the CSPRNG, hex-encoded at the exact byte sizes the Go issuer uses
// (pkg/auth/issue.go): 16-byte keyId, 32-byte secret. Hex guarantees neither
// component contains the '_' separator the key format splits on.
export class NodeKeyMaterialGenerator implements KeyMaterialGenerator {
  generate(): KeyMaterial {
    return {
      keyId: randomBytes(KEY_ID_BYTES).toString('hex'),
      secret: randomBytes(SECRET_BYTES).toString('hex'),
    };
  }
}
