import { createHmac, hkdfSync } from 'node:crypto';

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
 * The visitor is its ADDRESS (`clientAddress`: an IPv4 address, or the /64 an IPv6 host picks its
 * addresses from), and the key is never the address itself: an
 * HMAC-SHA256 of the form id and the address. Keyed, because an address is 32 bits and a plain hash
 * of one is reversed by trying them all; per form, so two forms' rows cannot be joined into one
 * visitor's trail. The key is pseudonymous personal data and lives only while it counts:
 * `forgetSettledGuestVisitors` clears it once the answer stops waiting.
 *
 * Its HMAC key is DEDICATED (`GUEST_VISITOR_KEY_INFO`): derived from the internal secret by HKDF,
 * never the raw secret, which authenticates calls between services. So nothing computed here is
 * ever an HMAC under the credential itself, and this key can be rotated by its label alone.
 *
 * A room of guests behind ONE address (an event hall's network) shares the ceiling: three of them
 * may be waiting to pay at once, the fourth waits a moment or pays in cash later. A known cost of
 * PP5, measured nowhere yet ("to evaluate", the chantier says).
 */

/** PP5: the most answers one visitor may have waiting for payment on one public form at once. */
export const GUEST_PENDING_CEILING = 3;

/** The `code` of the 429 a visitor gets past the ceiling; the page words it (`paymentRefusal.ts`). */
export const GUEST_PENDING_LIMIT = 'GUEST_PENDING_LIMIT';

/** The HKDF label of the visitor key: its domain, and the one thing to change to rotate it. */
export const GUEST_VISITOR_KEY_INFO = 'canari:guest-visitor-key:v1';

/**
 * The visitor key's own HMAC key: 32 bytes HKDF-SHA256 from the internal secret, under
 * `GUEST_VISITOR_KEY_INFO`. Throws when the secret is unset: a key under an empty secret is a plain
 * hash, which is the one thing this must not be.
 */
export function guestVisitorHmacKey(): Buffer {
  const secret = process.env.INTERNAL_SECRET ?? '';
  if (!secret) throw new Error('INTERNAL_SECRET is unset: no guest visitor key can be derived');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), GUEST_VISITOR_KEY_INFO, 32));
}

/** The key a guest's paid answer carries (see the module comment). */
export function guestVisitorKey(formId: string, address: string): string {
  return createHmac('sha256', guestVisitorHmacKey())
    .update(`canari:guest-visitor:v1:${formId}:${address}`, 'utf8')
    .digest('hex');
}
