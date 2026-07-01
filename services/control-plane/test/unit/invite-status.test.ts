import { describe, expect, it } from 'vitest';
import { INVITE_STATUSES, isInviteStatus } from '../../src/domain/entities';

// Regression coverage for issue #209's "known latent issue": the domain
// InviteStatus type used to include 'expired', but nothing ever wrote that
// value (expiry is computed from expires_at, not persisted) and the DB CHECK
// constraint (migration 000018) plus the shared `inviteStatusSchema`
// (contracts/invite.ts) only allow pending/consumed/revoked. A status value
// accepted by the domain type but rejected by the shared contract would trip
// the BFF's Zod parse identically to the #208 `invitedBy`/`createdBy` bug the
// moment any code (e.g. a future expiry sweep) ever wrote it.
describe('InviteStatus_DomainEnum_MirrorsDbAndContract', () => {
  it('is exactly pending, consumed, revoked (no dormant "expired" member)', () => {
    expect(INVITE_STATUSES).toEqual(['pending', 'consumed', 'revoked']);
  });
});

describe('isInviteStatus_ValidValue_ReturnsTrue', () => {
  it.each(INVITE_STATUSES)('accepts %s', (status) => {
    expect(isInviteStatus(status)).toBe(true);
  });
});

describe('isInviteStatus_InvalidValue_ReturnsFalse', () => {
  it('rejects the dormant "expired" value', () => {
    expect(isInviteStatus('expired')).toBe(false);
  });

  it('rejects an arbitrary garbage string', () => {
    expect(isInviteStatus('not-a-status')).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(isInviteStatus(undefined)).toBe(false);
    expect(isInviteStatus(null)).toBe(false);
    expect(isInviteStatus(42)).toBe(false);
  });
});
