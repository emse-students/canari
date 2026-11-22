/**
 * EXACTLY the shape core-service accepts for `payerEmail` (`PAYER_EMAIL_RE` and
 * `PAYER_EMAIL_MAX_LENGTH` in `payment.controller.ts`), so the client never sends an address core
 * refuses: loose on purpose, the payment provider is the authority on deliverability and this only
 * refuses obvious junk. Domain labels exclude the dot, so `a@b..fr` and `a@b.fr.` are refused here
 * as they are there.
 */
const PAYER_EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const PAYER_EMAIL_MAX_LENGTH = 254;

/** Returns the trimmed address when it looks like an email, `null` otherwise. */
export function normalizePayerEmail(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length <= PAYER_EMAIL_MAX_LENGTH && PAYER_EMAIL_RE.test(trimmed) ? trimmed : null;
}
