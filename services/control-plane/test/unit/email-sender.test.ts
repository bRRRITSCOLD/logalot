// Unit tests for the EmailSender adapters (NoOp + SMTP) and the invite email
// template.  All tests use a fake / in-memory transport — no real SMTP calls.
//
// Coverage targets (issue #152 acceptance criteria):
//   R-INV-12  NoOp logs no token / link; SMTP send path logs no body.
//   R-INV-13  CRLF in recipient rejected; <script> in interpolated field escaped;
//             header set comes only from structured params.
//   R-INV-14  SMTP send targets only the passed recipient (no open-relay drift).
//   SMTP failure surfaces as a rejected promise (so Task 11 can catch it).

import { describe, expect, it, vi } from 'vitest';
import { buildInviteEmail } from '../../src/adapters/email/invite-email-template';
import { NoOpEmailSender } from '../../src/adapters/email/noop-email-sender';
import { SmtpEmailSender } from '../../src/adapters/email/smtp-email-sender';
import type { EmailMessage } from '../../src/app/ports';
import { ValidationError } from '../../src/domain/errors';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_MESSAGE: EmailMessage = {
  to: 'alice@example.com',
  subject: 'You have been invited',
  text: 'Accept here: https://app.logalot.io/invite/abc',
  html: '<p>Accept <a href="https://app.logalot.io/invite/abc">here</a></p>',
};

// ── NoOpEmailSender ───────────────────────────────────────────────────────────

describe('NoOpEmailSender', () => {
  it('resolves without throwing on a valid message', async () => {
    const sender = new NoOpEmailSender();
    await expect(sender.send(VALID_MESSAGE)).resolves.toBeUndefined();
  });

  it('logs only the recipient address to stderr — no body, no link, no token (R-INV-12)', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const sender = new NoOpEmailSender();
    await sender.send(VALID_MESSAGE);

    const parsed = written.map((line) => JSON.parse(line));
    // Must contain the recipient
    expect(parsed.some((o) => o.to === 'alice@example.com')).toBe(true);
    // Must NOT contain any value that looks like the invite link or token
    const raw = written.join('');
    expect(raw).not.toContain('https://app.logalot.io/invite/abc');
    expect(raw).not.toContain('lginv_'); // invite token prefix
    // Must NOT log body or html
    for (const o of parsed) {
      expect(o).not.toHaveProperty('text');
      expect(o).not.toHaveProperty('html');
      expect(o).not.toHaveProperty('body');
    }

    vi.restoreAllMocks();
  });
});

// ── SmtpEmailSender ───────────────────────────────────────────────────────────

describe('SmtpEmailSender', () => {
  /**
   * Creates an SmtpEmailSender backed by a nodemailer fake transport.
   * The fake transport captures every sendMail call in `sent`.
   */
  function makeSender() {
    const sent: Array<{
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string | undefined;
    }> = [];

    // We override the transport.sendMail after construction by replacing the
    // transport on the instance via a spy on nodemailer.createTransport.
    // Simpler: pass through the SmtpEmailSender constructor and replace the
    // internal transport with a fake that captures calls.
    const sender = new SmtpEmailSender({
      host: 'localhost',
      port: 1025,
      user: undefined,
      pass: undefined,
      from: 'noreply@logalot.io',
    });

    // Replace the private transport with a fake that captures calls
    // (cast to any to access private field in tests only).
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
    (sender as any).transport = {
      sendMail: vi.fn().mockImplementation(async (opts: (typeof sent)[number]) => {
        sent.push({
          from: opts.from,
          to: opts.to,
          subject: opts.subject,
          text: opts.text,
          html: opts.html,
        });
        return { messageId: '<fake@localhost>' };
      }),
    };

    return { sender, sent };
  }

  it('delivers a message to the correct recipient (R-INV-14)', async () => {
    const { sender, sent } = makeSender();
    await sender.send(VALID_MESSAGE);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('alice@example.com');
    expect(sent[0]?.from).toBe('noreply@logalot.io');
  });

  it('passes through subject, text, and html from the EmailMessage', async () => {
    const { sender, sent } = makeSender();
    await sender.send(VALID_MESSAGE);

    expect(sent[0]?.subject).toBe('You have been invited');
    expect(sent[0]?.text).toContain('Accept here');
    expect(sent[0]?.html).toContain('<p>Accept');
  });

  it('does not construct any raw header strings — uses structured params only (R-INV-13)', async () => {
    // This verifies the design: SmtpEmailSender passes a typed object to
    // sendMail() and never builds header strings like "To: " + recipient.
    // The fake transport captures exactly what was passed, so if structured
    // params were used the `to` field is just the address, not a header line.
    const { sender, sent } = makeSender();
    await sender.send(VALID_MESSAGE);

    const toField = sent[0]?.to ?? '';
    // A header-injection attempt via concatenation would produce "alice@example.com\r\nBcc: attacker@x.com"
    expect(toField).not.toContain('\r');
    expect(toField).not.toContain('\n');
    // And the to value is purely the recipient, not a raw "To: ..." header line
    expect(toField).not.toMatch(/^To:/i);
  });

  it('surfaces SMTP transport failures as a rejected promise (for Task 11 catch)', async () => {
    const sender = new SmtpEmailSender({
      host: 'localhost',
      port: 1025,
      user: undefined,
      pass: undefined,
      from: 'noreply@logalot.io',
    });

    // Inject a failing transport
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private field
    (sender as any).transport = {
      sendMail: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    };

    await expect(sender.send(VALID_MESSAGE)).rejects.toThrow('connect ECONNREFUSED');
  });

  it('logs only recipient to stderr on success — no body, no link (R-INV-12)', async () => {
    const { sender } = makeSender();
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await sender.send(VALID_MESSAGE);

    const parsed = written.map((line) => JSON.parse(line));
    expect(parsed.some((o) => o.to === 'alice@example.com')).toBe(true);

    const raw = written.join('');
    expect(raw).not.toContain('https://app.logalot.io/invite/abc');
    for (const o of parsed) {
      expect(o).not.toHaveProperty('text');
      expect(o).not.toHaveProperty('html');
      expect(o).not.toHaveProperty('body');
    }

    vi.restoreAllMocks();
  });
});

// ── buildInviteEmail (template) ───────────────────────────────────────────────

describe('buildInviteEmail', () => {
  const VALID_FIELDS = {
    recipientEmail: 'bob@example.com',
    inviteUrl: 'https://app.logalot.io/accept?id=invite-uuid-1',
    inviteId: 'invite-uuid-1',
    tenantName: 'Acme Corp',
  };

  it('produces a valid EmailMessage with the correct recipient', () => {
    const msg = buildInviteEmail(VALID_FIELDS);

    expect(msg.to).toBe('bob@example.com');
    expect(msg.subject).toContain('Acme Corp');
    expect(msg.text).toContain(VALID_FIELDS.inviteUrl);
    expect(msg.html).toContain(VALID_FIELDS.inviteUrl);
  });

  it('HTML-escapes <script> in an interpolated field (R-INV-13 XSS)', () => {
    const msg = buildInviteEmail({
      ...VALID_FIELDS,
      tenantName: '<script>alert(1)</script>',
    });

    // The raw tag must not appear in the HTML body
    expect(msg.html).not.toContain('<script>');
    // But the escaped form must be present
    expect(msg.html).toContain('&lt;script&gt;');
  });

  it('HTML-escapes double-quotes in tenantName (attribute injection)', () => {
    const msg = buildInviteEmail({
      ...VALID_FIELDS,
      tenantName: 'Acme"onmouseover="alert(1)',
    });

    expect(msg.html).not.toContain('"onmouseover=');
    expect(msg.html).toContain('&quot;');
  });

  it('HTML-escapes & in tenantName', () => {
    const msg = buildInviteEmail({
      ...VALID_FIELDS,
      tenantName: 'Acme & Co',
    });

    expect(msg.html).not.toContain('Acme & Co');
    expect(msg.html).toContain('Acme &amp; Co');
  });

  it('rejects CRLF in recipientEmail (header injection — R-INV-13)', () => {
    expect(() =>
      buildInviteEmail({
        ...VALID_FIELDS,
        recipientEmail: 'bob@example.com\r\nBcc: attacker@evil.com',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects CR alone in recipientEmail', () => {
    expect(() =>
      buildInviteEmail({
        ...VALID_FIELDS,
        recipientEmail: 'bob@example.com\rattacker',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects LF alone in recipientEmail', () => {
    expect(() =>
      buildInviteEmail({
        ...VALID_FIELDS,
        recipientEmail: 'bob@example.com\nBcc: x@y.com',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects C0 control characters in tenantName (R-INV-13)', () => {
    expect(() =>
      buildInviteEmail({
        ...VALID_FIELDS,
        tenantName: 'Acme\x00Corp',
      }),
    ).toThrow(ValidationError);
  });

  it('does NOT escape the server-built inviteUrl (trusted source)', () => {
    const url = 'https://app.logalot.io/accept?id=abc&token=xyz';
    const msg = buildInviteEmail({ ...VALID_FIELDS, inviteUrl: url });

    // & in the URL should NOT be double-escaped (it's a trusted server URL)
    expect(msg.html).toContain(url);
  });

  it('the invite token (lginv_...) does not appear in subject or visible text', () => {
    // The inviteUrl MAY contain an opaque id, but the raw token prefix 'lginv_'
    // must not be interpolated into any field directly by the template.
    const msg = buildInviteEmail(VALID_FIELDS);

    // template should only include the URL, not a raw 'lginv_' prefix in body copy
    expect(msg.subject).not.toContain('lginv_');
    expect(msg.text.replace(VALID_FIELDS.inviteUrl, '')).not.toContain('lginv_');
  });
});
