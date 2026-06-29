// normalizeEmail applies the three-step canonicalization defined in R14:
//   1. Unicode NFC composition (so ä via decomposed combining sequence == ä as
//      precomposed — handles copy-paste differences across keyboards/OS).
//   2. Trim leading/trailing whitespace (the most common typo in email fields).
//   3. ASCII-lowercase (RFC 5321 §2.4 — local part is case-insensitive in
//      practice; domain is always case-insensitive per RFC 1035).
//
// What it intentionally does NOT do:
//   - Homograph/confusable folding (e.g. Cyrillic 'а' ≠ Latin 'a'). That
//     requires ICU confusable-mapping tables and is a separate policy concern;
//     folding here would silently conflate distinct identities.
//   - Punycode encoding of IDN domains — consumers that need it (e.g. an SMTP
//     relay) must encode after normalization.
//   - Validation — call site must validate the shape before or after.
//
// The function is idempotent: normalizeEmail(normalizeEmail(x)) === normalizeEmail(x).
export function normalizeEmail(raw: string): string {
  return raw.normalize('NFC').trim().toLowerCase();
}
