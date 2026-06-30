import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { InviteProvisioner, InviteProvisionInput, OAuthAuditLogger } from '../../app/ports';
import { ConflictError } from '../../domain/errors';
import type { MembershipRole } from '../../domain/roles';
import { consumeWithClient } from './invite-repository';
import { linkFirstWithClient } from './oauth-identity-repository';
import { withTenantTx } from './tenant-tx';
import { insertUserWithMembership } from './user-repository';

// DISABLED_PASSWORD is stored as the `password_hash` for users provisioned via
// invite. It is intentionally NOT a valid bcrypt hash (no `$2` prefix), so it
// can NEVER match any plaintext password — the user must authenticate via OAuth
// (R-INV-8 / ADR-0012: invite-only, no password auth path for provisioned users).
const DISABLED_PASSWORD = '!disabled';

// translateRole maps from the Invites context role vocabulary ('admin' | 'member')
// to the MembershipRole enum used by the users/memberships tables (R-INV-8).
// Input is ALWAYS the consumed invite row's role — never client-supplied input.
function translateRole(inviteRole: string): MembershipRole {
  if (inviteRole === 'admin') return 'tenant_admin';
  return 'member';
}

// hashForAudit returns the SHA-256 hex digest of a value so the audit trail
// carries a privacy-safe correlator rather than the raw PII/secret (threat
// model R17). Never use on passwords — they are KDF'd separately.
function hashForAudit(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// NO_OP_AUDIT_LOGGER is the default when no auditLogger is injected. Prevents
// the adapter from crashing in tests that don't assert on audit events.
const NO_OP_AUDIT_LOGGER: OAuthAuditLogger = { log: () => {} };

export interface PgInviteProvisionerDeps {
  pool: Pool;
  /** Structured audit logger — emits invite_provisioned on success. */
  auditLogger?: OAuthAuditLogger;
}

// PgInviteProvisioner is the Postgres UoW adapter for the InviteProvisioner port
// (issue #149 / ADR-0012 §5). It opens ONE withTenantTx and runs, in order:
//
//   (1) consumeWithClient — the atomic single-use gate (R-INV-3). A null result
//       (no matching pending/unexpired row, wrong email, race lost, etc.) causes
//       the transaction to roll back and returns null to the caller.
//
//   (2) insertUserWithMembership — creates the user + membership row with the
//       role read from the consumed invite (R-INV-8: role comes from the row,
//       never from client input). A ConflictError (duplicate email) or any other
//       error rolls back the entire tx — the invite reverts to 'pending'.
//
//   (3) linkFirstWithClient — links the Google OAuth identity to the new user
//       (R-INV-17 atomicity). Because the user was just created in step 2, the
//       UNIQUE(tenant_id,user_id,provider) conflict (user already pinned to a
//       different sub) is unreachable. The reachable conflict is
//       UNIQUE(tenant_id,provider,provider_sub): the same Google sub is already
//       linked to a DIFFERENT user in this tenant. linkFirstWithClient handles
//       that idempotently — it returns the OTHER user's ref. We detect this via
//       link.userId !== user.id and throw a ConflictError, which the outer catch
//       converts to null, rolling back the entire tx so the invite reverts to
//       'pending' (R-INV-17) and no orphan user/membership row is committed.
//
// On success: emits an `invite_provisioned` audit event (hashed providerSub,
// never the raw value — privacy-by-design, R17) and returns { userId }.
// On ANY failure: returns null so the authenticator throws a uniform 401 (no
// enumeration oracle).
export class PgInviteProvisioner implements InviteProvisioner {
  private readonly auditLogger: OAuthAuditLogger;

  constructor(private readonly deps: PgInviteProvisionerDeps) {
    this.auditLogger = deps.auditLogger ?? NO_OP_AUDIT_LOGGER;
  }

  async provisionFromInvite(
    tenantId: string,
    input: InviteProvisionInput,
  ): Promise<{ userId: string } | null> {
    try {
      const result = await withTenantTx(this.deps.pool, tenantId, async (client) => {
        // ── Step 1: Atomically consume the invite (R-INV-3 single-use gate). ──
        // Folds email-binding + single-use + expiry + status into one conditional
        // UPDATE. Returns null on every failure mode (no row, wrong email, expired,
        // revoked, already consumed, lost the race) → uniform null → 401.
        const consumed = await consumeWithClient(client, {
          tokenHash: input.inviteTokenHash,
          email: input.email,
          now: input.now,
        });
        if (!consumed) return null;

        // ── Step 2: Create user + membership (R-INV-8 role from row, not input). ──
        // Role is translated from the Invites vocabulary to the MembershipRole enum
        // here — the ONLY place the translation happens (not at the HTTP boundary,
        // not at the storage boundary). A ConflictError (email taken) or any other
        // error unwinds the tx, leaving the invite 'pending' (R-INV-17).
        const membershipRole = translateRole(consumed.role);
        const user = await insertUserWithMembership(client, tenantId, {
          email: input.email,
          passwordHash: DISABLED_PASSWORD,
          role: membershipRole,
        });

        // ── Step 3: Link the OAuth identity in the same transaction (R-INV-17). ──
        // linkFirstWithClient uses a SAVEPOINT internally. If the same Google sub is
        // already linked to a DIFFERENT user in this tenant, linkFirstWithClient rolls
        // back to its savepoint, re-SELECTs, and returns the OTHER user's ref — it
        // does NOT throw. We must detect this case explicitly: if link.userId differs
        // from user.id, the Google account is already taken by someone else. Throw a
        // ConflictError so the outer catch rolls back the entire tx (invite reverts to
        // 'pending', no orphan user/membership row is committed — R-INV-17).
        const link = await linkFirstWithClient(client, tenantId, {
          userId: user.id,
          provider: 'google',
          providerSub: input.providerSub,
          email: input.email,
        });
        if (link.userId !== user.id) {
          throw new ConflictError(
            'Google account is already linked to a different user in this tenant',
          );
        }

        return { userId: user.id };
      });

      if (!result) return null;

      // ── Emit invite_provisioned audit event on success. ──
      // Raw providerSub is NEVER logged — only its SHA-256 hex digest
      // (privacy-by-design, threat model R17). Email is not logged at all.
      // Failures are swallowed: audit logging must never abort the provisioning flow.
      try {
        this.auditLogger.log({
          tenantId,
          userId: result.userId,
          provider: 'google',
          hashedSub: hashForAudit(input.providerSub),
          outcome: 'invite_provisioned',
          ts: input.now,
        });
      } catch {
        // Non-fatal: never let the audit logger abort the provisioning flow.
      }

      return result;
    } catch (err) {
      // ConflictError bubbles from three sources, all collapse to null:
      //   • step 2 (insertUserWithMembership): duplicate email — a user with that
      //     address already exists; provisioning is not possible via this invite.
      //   • step 3 (our explicit check): the Google sub is already linked to a
      //     DIFFERENT user in this tenant; the tx is rolled back by withTenantTx.
      //   • step 3 (linkFirstWithClient case b): user already pinned to a different
      //     sub — unreachable here (user was just created in step 2) but handled
      //     defensively. The enclosing withTenantTx already rolled back the tx.
      // Return null so the authenticator throws a uniform 401 (no enumeration oracle).
      if (err instanceof ConflictError) return null;
      throw err;
    }
  }
}
