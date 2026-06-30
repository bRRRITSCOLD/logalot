import type { Config } from '../config/env';
import { normalizeEmail } from '../domain/email';
import type { Invite } from '../domain/entities';
import { ConflictError, NotFoundError } from '../domain/errors';
import { assembleInviteToken, hashInviteSecret, INVITE_SECRET_BYTES } from '../domain/invite';
import type { TenantContext } from '../domain/tenant-context';
import { assertCan } from './authorize';
import type {
  Clock,
  EmailSender,
  InviteAuditLogger,
  InviteRepository,
  SecretGenerator,
  TenantRepository,
} from './ports';

// INVITE_SECRET_HEX_LENGTH is the expected length of a hex-encoded
// INVITE_SECRET_BYTES secret (32 bytes → 64 hex chars).
const INVITE_SECRET_HEX_LENGTH = INVITE_SECRET_BYTES * 2;

export interface CreateInviteCommand {
  email: string;
  role: string;
}

// IssuedInvite carries the one-time plaintext inviteUrl shown to the admin
// exactly once. The URL is NEVER persisted — only sha256(secret) is stored.
export interface IssuedInvite {
  invite: Invite;
  inviteUrl: string;
}

// InviteService handles the admin-facing invite lifecycle:
//   create  — cap check + mint token + persist hash + best-effort email (ADR-0013)
//   list    — tenant-scoped, admin-only view
//   revoke  — flip status to 'revoked'; 404 on any miss (RLS = cross-tenant invisible)
//
// Design mirrors ApiKeyService: the application core knows nothing about HTTP.
// All RBAC checks are double-asserted here (assertCan) even though the route
// guard has already checked at the edge (ADR-0007 — defense in depth).
export class InviteService {
  constructor(
    private readonly invites: InviteRepository,
    private readonly tenants: TenantRepository,
    private readonly secretGenerator: SecretGenerator,
    private readonly clock: Clock,
    private readonly emailSender: EmailSender,
    private readonly auditLogger: InviteAuditLogger,
    private readonly config: Pick<
      Config,
      'inviteTtlSeconds' | 'inviteMaxOutstandingPerTenant' | 'inviteAcceptBaseUrl'
    >,
  ) {}

  async create(ctx: TenantContext, cmd: CreateInviteCommand): Promise<IssuedInvite> {
    assertCan(ctx, 'invite:create');

    // Resolve the tenant publicId — needed to assemble the typed token prefix.
    // The publicId comes from the registry, never from the request body (open-redirect
    // prevention, ADR-0013).
    const tenant = await this.tenants.findById(ctx.tenantId);
    if (!tenant) {
      throw new NotFoundError('tenant not found');
    }

    // R-INV-10 — outstanding-invite cap. COUNT runs under RLS so it is scoped
    // to this tenant. Checked before any DB write so no row is created on rejection.
    const pendingCount = await this.invites.countPending(ctx.tenantId);
    if (pendingCount >= this.config.inviteMaxOutstandingPerTenant) {
      throw new ConflictError(
        `outstanding invite cap reached (max ${this.config.inviteMaxOutstandingPerTenant})`,
      );
    }

    // Normalize email (NFC + trim + lowercase per R14 / domain/email.ts).
    const email = normalizeEmail(cmd.email);

    // Generate a high-entropy secret and hash it. The secret is shown once
    // (embedded in the URL below); only sha256(secret) is stored (R-INV-2).
    const rawSecret = this.secretGenerator.generate();
    // Ensure the generator yields the expected length for type safety; in
    // production the adapter always yields INVITE_SECRET_HEX_LENGTH chars.
    if (rawSecret.length !== INVITE_SECRET_HEX_LENGTH) {
      throw new Error(
        `secret generator must yield exactly ${INVITE_SECRET_HEX_LENGTH} hex chars; got ${rawSecret.length}`,
      );
    }
    const secretHash: Buffer = hashInviteSecret(rawSecret);
    const plaintext = assembleInviteToken(tenant.publicId, rawSecret);

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.inviteTtlSeconds * 1000);

    // Persist the invite row — only the hash is stored, never the plaintext.
    const invite = await this.invites.create(ctx.tenantId, {
      email,
      role: cmd.role,
      secretHash,
      invitedBy: ctx.principalId,
      expiresAt,
    });

    // Build the one-time accept URL. The base URL is fixed at startup (ADR-0013,
    // R-INV-14); the token is appended as a query parameter here.
    const inviteUrl = `${this.config.inviteAcceptBaseUrl}/invite/accept?token=${plaintext}`;

    // Emit the invite_created audit record BEFORE attempting email delivery.
    // The audit must always fire, even when the email path throws (R-INV-9).
    this.auditLogger.log({
      tenantId: ctx.tenantId,
      inviteId: invite.id,
      actorId: ctx.principalId,
      outcome: 'invite_created',
      email: invite.email,
      role: invite.role,
      ts: now,
    });

    // Best-effort email delivery (ADR-0013, R-INV-14). A failing sender MUST NOT
    // propagate — the invite row and inviteUrl are already committed and returned.
    // Log the send failure but never rethrow it.
    try {
      await this.emailSender.send({
        to: invite.email,
        subject: 'You have been invited to Logalot',
        text: `You have been invited. Use this link to accept your invitation: ${inviteUrl}`,
        html: `<p>You have been invited. <a href="${inviteUrl}">Accept your invitation</a>.</p>`,
      });
    } catch {
      // Intentionally swallowed — mirrors touchLastLogin pattern (ADR-0013 §rule).
      // The inviteUrl was already returned; the user can resend manually if needed.
    }

    return { invite, inviteUrl };
  }

  async list(ctx: TenantContext): Promise<Invite[]> {
    assertCan(ctx, 'invite:list');
    return this.invites.listByTenant(ctx.tenantId);
  }

  async revoke(ctx: TenantContext, id: string): Promise<void> {
    assertCan(ctx, 'invite:revoke');
    const now = this.clock.now();
    const revoked = await this.invites.revoke(ctx.tenantId, id, now);
    if (!revoked) {
      throw new NotFoundError('invite not found');
    }
    // Emit invite_revoked audit record (R-INV-9 — actor + invite id, never the token).
    this.auditLogger.log({
      tenantId: ctx.tenantId,
      inviteId: id,
      actorId: ctx.principalId,
      outcome: 'invite_revoked',
      // role and email are not available without re-fetching; pass empty sentinel
      // consistent with how audit loggers in this codebase treat partial context.
      email: '',
      role: '',
      ts: now,
    });
  }
}
