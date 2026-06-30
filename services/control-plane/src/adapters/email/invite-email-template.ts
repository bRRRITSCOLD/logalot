// Injection-safe invite email template (R-INV-13).
//
// Two classes of injection are guarded against:
//
//   Header injection (SMTP / RFC 2822):
//     CR (U+000D) or LF (U+000A) in the `to` field or any interpolated value
//     could be smuggled into the MIME header block and add rogue `Bcc:` or
//     `Cc:` lines.  We reject at input: any value containing C0 control
//     characters (U+0000–U+001F) raises a ValidationError.  The structured
//     { to, subject, text, html } API of nodemailer then owns header assembly,
//     so no string-concatenated headers are ever constructed here.
//
//   HTML injection (XSS):
//     An invitee-controlled email address embedded in the HTML body could
//     inject `<script>` or attribute-breaking characters. We escape the five
//     dangerous HTML meta-characters (< > & " ') before interpolation.
//     The invite URL is server-built (INVITE_ACCEPT_BASE_URL from fixed config),
//     so it is trusted and is emitted without escaping; only user-supplied
//     fields are escaped.
//
// The send path MUST NOT embed the invite token or the full accept URL in logs
// (R-INV-12).  Callers are responsible — this module produces the message
// object; it is the SmtpEmailSender / caller that decides what is logged.

import type { EmailMessage } from '../../app/ports';
import { ValidationError } from '../../domain/errors';

// ── Injection guard ───────────────────────────────────────────────────────────

/**
 * C0_PATTERN matches any Unicode control character (category Cc), including
 * CR (U+000D), LF (U+000A), NUL (U+0000), and the full C0 range.  Used to
 * reject header-injection attempts in the `to` field and any interpolated
 * value (R-INV-13).  The /u flag enables Unicode property escapes.
 */
const C0_PATTERN = /\p{Cc}/u;

/**
 * assertNoControlChars throws ValidationError if `value` contains CR, LF, or
 * any other C0 control character.
 */
function assertNoControlChars(value: string, field: string): void {
  if (C0_PATTERN.test(value)) {
    throw new ValidationError(
      `${field} contains disallowed control character (header injection rejected)`,
    );
  }
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

/** HTML-escape the five dangerous meta-characters that could break attribute
 * values or introduce script elements. Used for every user-supplied field. */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Template input ────────────────────────────────────────────────────────────

export interface InviteEmailFields {
  /** Normalized recipient address (from invites.email). */
  recipientEmail: string;
  /**
   * The server-built accept URL — constructed from INVITE_ACCEPT_BASE_URL
   * (a fixed config value) plus the public invite id. NEVER derived from
   * request data (ADR-0013, R-INV-14).
   *
   * This is the ONLY URL embedded in the message; it is trusted and not
   * user-supplied, so it is emitted verbatim. The token itself must NOT appear
   * in subject/text/html — only the URL that includes it, and only the URL
   * path that the server controls.
   */
  inviteUrl: string;
  /** Public invite id (NOT the token) — used for the audit trail only. */
  inviteId: string;
  /** Tenant display name shown in the body copy. */
  tenantName: string;
}

// ── Message builder ───────────────────────────────────────────────────────────

/**
 * buildInviteEmail produces the injection-safe EmailMessage for an invitation.
 *
 * Guarantees:
 *   - recipientEmail and tenantName are checked for C0 control chars (R-INV-13).
 *   - All user-supplied fields are HTML-escaped before interpolation.
 *   - The invite URL is trusted (server-built) and emitted verbatim.
 *   - The invite token is NOT present in subject, text, or html — only the
 *     server-controlled accept URL (R-INV-12).
 */
export function buildInviteEmail(fields: InviteEmailFields): EmailMessage {
  const { recipientEmail, inviteUrl, tenantName } = fields;

  // Reject control characters in all fields that originate from user or
  // database input (the invite URL is server-built and therefore trusted).
  assertNoControlChars(recipientEmail, 'recipientEmail');
  assertNoControlChars(tenantName, 'tenantName');

  // HTML-escape user-supplied fields before interpolation.
  const safeEmail = escapeHtml(recipientEmail);
  const safeTenantName = escapeHtml(tenantName);

  const subject = `You've been invited to ${tenantName}`;
  const text = [
    `You've been invited to join ${tenantName} on Logalot.`,
    '',
    `Accept your invitation here:`,
    inviteUrl,
    '',
    `This link will expire in 7 days. If you did not expect this invitation, you can safely ignore this email.`,
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Invitation to ${safeTenantName}</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h1 style="font-size:1.25rem">You've been invited to join ${safeTenantName}</h1>
  <p>Hi ${safeEmail},</p>
  <p>An admin has invited you to join <strong>${safeTenantName}</strong> on Logalot.</p>
  <p style="margin:24px 0">
    <a href="${inviteUrl}"
       style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">
      Accept invitation
    </a>
  </p>
  <p style="color:#6b7280;font-size:0.875rem">
    This link will expire in 7 days. If you did not expect this invitation,
    you can safely ignore this email.
  </p>
</body>
</html>`;

  return {
    to: recipientEmail,
    subject,
    text,
    html,
  };
}
