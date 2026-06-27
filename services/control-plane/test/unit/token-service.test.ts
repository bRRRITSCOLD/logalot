import { describe, expect, it } from 'vitest';
import { JoseTokenService } from '../../src/adapters/crypto/jose-token-service';

const config = { secret: 'a-very-long-test-signing-secret', accessTtlSeconds: 900 };

describe('JoseTokenService (access JWT)', () => {
  it('issues a verifiable access token carrying tenant + role claims', async () => {
    const svc = new JoseTokenService(config);
    const { token, expiresInSeconds } = await svc.issueAccess({
      tenantId: '00000000-0000-0000-0000-0000000000a1',
      principalId: '00000000-0000-0000-0000-0000000000b1',
      role: 'tenant_admin',
    });
    expect(expiresInSeconds).toBe(900);
    const claims = await svc.verifyAccess(token);
    expect(claims).toEqual({
      tenantId: '00000000-0000-0000-0000-0000000000a1',
      principalId: '00000000-0000-0000-0000-0000000000b1',
      role: 'tenant_admin',
    });
  });

  it('rejects a token signed with a different secret (signature verification)', async () => {
    const issuer = new JoseTokenService(config);
    const attacker = new JoseTokenService({ ...config, secret: 'a-different-long-secret-value' });
    const { token } = await issuer.issueAccess({
      tenantId: '00000000-0000-0000-0000-0000000000a1',
      principalId: '00000000-0000-0000-0000-0000000000b1',
      role: 'member',
    });
    await expect(attacker.verifyAccess(token)).rejects.toThrow();
  });

  it('rejects a tampered token', async () => {
    const svc = new JoseTokenService(config);
    const { token } = await svc.issueAccess({
      tenantId: '00000000-0000-0000-0000-0000000000a1',
      principalId: '00000000-0000-0000-0000-0000000000b1',
      role: 'member',
    });
    await expect(svc.verifyAccess(`${token}x`)).rejects.toThrow();
  });

  it('rejects an already-expired token', async () => {
    const svc = new JoseTokenService({ ...config, accessTtlSeconds: -1 });
    const { token } = await svc.issueAccess({
      tenantId: '00000000-0000-0000-0000-0000000000a1',
      principalId: '00000000-0000-0000-0000-0000000000b1',
      role: 'member',
    });
    await expect(svc.verifyAccess(token)).rejects.toThrow();
  });
});
