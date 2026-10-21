import { createHmac } from 'node:crypto';

/**
 * THE PER-VISITOR CEILING OF A PUBLIC FORM'S UNPAID ANSWERS (WP-P3, decision PP5).
 *
 * A guest's paid answer holds a seat while it waits - 30 minutes online (`seat-hold.ts`), until the
 * organiser's cash deadline in cash - and a public form takes any number of answers from one link
 * (`allowMultipleSubmissions` is forced on). Without a ceiling, one script fills every seat of an
 * event with answers nobody will pay. The throttle (30 per minute per visitor) only slows it.
 *
 * So the ROWS say who is waiting: a guest's paid answer carries `guestVisitorKey`, and a visitor
 * already holding `GUEST_PENDING_CEILING` such answers on the form is refused another, counted
 * under the form's seat lock - never from a clock or a counter in memory, which a restart forgets
 * and two replicas would each keep.
 *
 * The visitor is its ADDRESS (`clientAddress`), and the key is never the address itself: an
 * HMAC-SHA256 under the service's internal secret, of the form id and the address. Keyed, because
 * an address is 32 bits and a plain hash of one is reversed by trying them all; per form, so two
 * forms' rows cannot be joined into one visitor's trail. The key is pseudonymous personal data and
 * lives only while it counts: `forgetSettledGuestVisitors` clears it once the answer stops waiting.
 *
 * A room of guests behind ONE address (an event hall's network) shares the ceiling: three of them
 * may be waiting to pay at once, the fourth waits a moment or pays in cash later. A known cost of
 * PP5, measured nowhere yet ("to evaluate", the chantier says).
 */

/** PP5: the most answers one visitor may have waiting for payment on one public form at once. */
export const GUEST_PENDING_CEILING = 3;

/** The `code` of the 429 a visitor gets past the ceiling; the page words it (`paymentRefusal.ts`). */
export const GUEST_PENDING_LIMIT = 'GUEST_PENDING_LIMIT';

/**
 * The key a guest's paid answer carries. Throws when the internal secret is unset: a key under an
 * empty secret is a plain hash, which is the one thing this must not be.
 */
export function guestVisitorKey(formId: string, address: string): string {
  const secret = process.env.INTERNAL_SECRET ?? '';
  if (!secret) throw new Error('INTERNAL_SECRET is unset: no guest visitor key can be derived');
  return createHmac('sha256', secret)
    .update(`canari:guest-visitor:v1:${formId}:${address}`, 'utf8')
    .digest('hex');
}
