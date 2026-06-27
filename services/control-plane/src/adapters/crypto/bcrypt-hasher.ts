import bcrypt from 'bcryptjs';
import type { PasswordHasher } from '../../app/ports';

// BcryptHasher implements PasswordHasher with bcrypt — a deliberately slow KDF,
// correct for low-entropy human passwords (ADR-0007). The cost factor is config-
// driven. Plaintext passwords are never logged or retained beyond the hash call.
export class BcryptHasher implements PasswordHasher {
  constructor(private readonly cost: number) {}

  hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, this.cost);
  }

  verify(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  }
}
