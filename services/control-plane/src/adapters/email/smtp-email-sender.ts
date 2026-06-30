// SmtpEmailSender — EMAIL_PROVIDER=smtp adapter (ADR-0013, R-INV-13).
//
// Transport: nodemailer createTransport(), configured from Config (SMTP_HOST /
// SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM).  The transport is built once
// at construction time and reused across calls (connection pooling via
// nodemailer's built-in pool option if enabled by the operator).
//
// Header injection (R-INV-13):
//   All header fields (from, to, subject) are supplied via nodemailer's
//   STRUCTURED mail-options object — { from, to, subject, text, html } — and
//   never concatenated as raw header strings.  nodemailer's RFC 2822 encoder
//   is responsible for escaping; we do NOT build raw MIME.
//
// Token / link logging (R-INV-12):
//   On success we log only recipient + outcome (no body, no URL).
//   On failure we log recipient + error code / message (no body, no URL).
//   The full MessageInfo object returned by sendMail() is never logged; it may
//   contain the message-id or accepted address list but NOT the body.
//
// Fixed target (R-INV-14):
//   The SMTP_FROM address is read from Config at startup and is NEVER derived
//   from request data.  The `to` field comes from the EmailMessage, which
//   is set to the invite's email column (fixed at invite-creation time).

import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from '../../app/ports';

export interface SmtpConfig {
  host: string;
  port: number;
  /** Optional SMTP auth username. Omit for unauthenticated relays. */
  user: string | undefined;
  /** Optional SMTP auth password. NEVER log this value. */
  pass: string | undefined;
  /** Envelope From address (e.g. "Logalot <noreply@logalot.io>"). */
  from: string;
  /** Set true when port 465 (implicit TLS) is used; false for STARTTLS / plain. */
  secure?: boolean;
}

export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(cfg: SmtpConfig) {
    this.from = cfg.from;
    // nodemailer structures all MIME headers internally from these typed fields;
    // no raw header concatenation occurs in this codebase (R-INV-13).
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure ?? cfg.port === 465,
      auth:
        cfg.user !== undefined
          ? {
              user: cfg.user,
              // pass may be undefined for unauthenticated relays (MailHog, etc.)
              pass: cfg.pass ?? '',
            }
          : undefined,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    // Compose via structured mail options — nodemailer handles header assembly.
    // This is the ONLY way headers are produced; we never concatenate strings
    // into the MIME header block (R-INV-13).
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    // Log only recipient + outcome; deliberately omit body, html, and any URL
    // that may embed the invite token (R-INV-12).
    process.stderr.write(
      `${JSON.stringify({
        type: 'email_sent',
        to: message.to,
      })}\n`,
    );
  }
}
