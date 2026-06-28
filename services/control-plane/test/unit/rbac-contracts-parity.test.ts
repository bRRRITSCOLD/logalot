import { can as contractsCan, UI_OPERATIONS } from '@logalot/contracts';
import { describe, expect, it } from 'vitest';
import { OPERATIONS as DOMAIN_OPERATIONS, can as domainCan } from '../../src/domain/rbac';
import { ROLES } from '../../src/domain/roles';

// ── RBAC mirror parity guard (PR #23 staff review I-1) ───────────────────────
//
// The admin UI hides/disables actions using a CLIENT-SIDE mirror of the
// authorization matrix shipped in @logalot/contracts (`can` / `UI_OPERATIONS`).
// That mirror is display-only and the control-plane is the sole authority — but a
// silent divergence (e.g. someone grants `alert:update` to `member` on one side
// only) would still be a confusing, hard-to-spot bug. This test makes drift
// impossible to merge by asserting the mirror agrees with the domain authority for
// EVERY mirrored operation × role.
//
// The domain matrix is a SUPERSET: it covers operations the UI never mirrors
// (saved queries, dashboards, the platform_operator tenant registry). So we assert:
//   1. the mirror's operation set is a subset of the domain's (no phantom ops); and
//   2. for every mirrored operation × every role, mirror.can === domain.can.
describe('contracts RBAC mirror ↔ control-plane authority parity', () => {
  it('mirrors only operations the domain authority actually defines (no phantom ops)', () => {
    const domainOps = new Set<string>(DOMAIN_OPERATIONS);
    for (const op of UI_OPERATIONS) {
      expect(domainOps.has(op), `UI_OPERATIONS member "${op}" is not a domain operation`).toBe(
        true,
      );
    }
  });

  it('agrees with the domain authority for every mirrored operation × role', () => {
    for (const role of ROLES) {
      for (const op of UI_OPERATIONS) {
        expect(contractsCan(role, op), `mirror disagrees with authority for ${role} × ${op}`).toBe(
          domainCan(role, op),
        );
      }
    }
  });
});
