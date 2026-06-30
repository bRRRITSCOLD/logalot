// NoOpEmailSender — the default EmailSender adapter when EMAIL_PROVIDER is
// unset or 'none' (ADR-0013, R-INV-12).
//
// Behaviour:
//   - Accepts the EmailMessage and returns immediately (no network call).
//   - Logs a single structured metadata line to stderr: recipient address and
//     invite id if present.  It NEVER logs the message body, HTML, or any URL
//     that could contain the invite token (R-INV-12).
//   - Suitable for local development, CI, and environments where email
//     delivery is deliberately disabled (invite links are returned in the API
//     response so the admin can copy/paste them).

import type { EmailMessage, EmailSender } from '../../app/ports';

export class NoOpEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    // Log only the recipient address; deliberately omit subject, text, and html
    // because any of those fields may contain the one-time invite URL / token
    // (R-INV-12 — the send path must never log the link or token).
    process.stderr.write(
      `${JSON.stringify({
        type: 'email_noop',
        to: message.to,
        // subject is safe to log (contains no token), but omit to keep the
        // metadata surface minimal and avoid any risk of future regressions.
      })}\n`,
    );
  }
}
