import { describe, expect, it } from 'vitest';
import { assembleRefreshToken, parseRefreshToken } from '../../src/domain/refresh-token';

describe('refresh token format', () => {
  it('assembles and parses lgr_<tenantId>_<tokenId>_<secret> (UUIDs have no _)', () => {
    const tenantId = '00000000-0000-0000-0000-0000000000a1';
    const tokenId = '11111111-1111-1111-1111-111111111111';
    const secret = 'deadbeef';
    const token = assembleRefreshToken(tenantId, tokenId, secret);
    expect(token).toBe(`lgr_${tenantId}_${tokenId}_${secret}`);
    expect(parseRefreshToken(token)).toEqual({ tenantId, tokenId, secret });
  });

  it('rejects malformed refresh tokens', () => {
    expect(() => parseRefreshToken('lgk_a_b_c')).toThrow(); // wrong prefix
    expect(() => parseRefreshToken('lgr_a_b')).toThrow(); // too few fields
  });
});
