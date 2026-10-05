/**
 * Same shape the server accepts for `payerEmail` (core-service `PAYER_EMAIL_RE`): loose on purpose,
 * the payment provider is the authority on deliverability and this only refuses obvious junk.
 */
const PAYER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns the trimmed address when it looks like an email, `null` otherwise. */
export function normalizePayerEmail(raw: string): string | null {
  const trimmed = raw.trim();
  return PAYER_EMAIL_RE.test(trimmed) ? trimmed : null;
}
