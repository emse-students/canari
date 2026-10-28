import { verifyLydiaSignature } from './lydia-signature';
import { lydiaAmountString } from './lydia-payment-provider';
import type { CheckoutRequestLookup } from './payment-provider.interface';

/**
 * How a `request/state` answer is proven to come from Lydia AND to be about a request of the
 * expected amount.
 *
 * LYDIA'S DOCUMENTATION (`/api/request/state`, read 2026-10-27; NOT MEASURED): "If a vendor_token is
 * provided, the return contains a signature. This signature ensures that you are connected to a
 * Lydia server. This signature is composed by: amount; request_id, request_uuid or order_ref (based
 * on what you give); business private token" - built like every Lydia signature (`signLydiaParams`:
 * MD5 of the `key=value` pairs sorted by key, joined by `&`, then `&` and the key).
 *
 * The answer carries NO amount (measured 2026-10-15), so the amount signed is the one the request
 * was issued for, known only to Lydia and to the caller: recomputing the signature over the
 * caller's EXPECTED amount verifies the origin and the amount in one comparison. The amount is
 * written exactly as `request/do` sent it (`lydiaAmountString`); whether Lydia signs that same
 * string is the part nobody has measured, and a wrong guess fails CLOSED (`mismatch`, nothing
 * settled), never open.
 *
 * WHAT IT DOES NOT COVER: the `state`. The documented composition leaves it out, so this proves
 * which request and which amount the answer is about, not what it says of them; the state rests on
 * the TLS read from Lydia's host, as it did before.
 */

/**
 * The verdict on one answer: `verified` (signed by the Business key over the expected amount and
 * the id read), `mismatch` (a signature that does not verify - another amount, another key, or a
 * malformed value), `unsigned` (Lydia answered none, e.g. the "not found" error of an order_ref
 * lookup), `no-key` (no Business key is stored for the vendor token, so nothing can be verified and
 * Lydia was not asked).
 */
export type RequestStateVerification = 'verified' | 'mismatch' | 'unsigned' | 'no-key';

/** The fields a `request/state` signature covers, for the lookup it answered. */
export function lydiaStateSignedFields(
  lookup: CheckoutRequestLookup,
  expectedAmountCents: number
): Record<string, string> {
  const amount = lydiaAmountString(expectedAmountCents);
  return 'orderRef' in lookup
    ? { amount, order_ref: lookup.orderRef }
    : { amount, request_uuid: lookup.requestUuid };
}

/**
 * Verifies a `request/state` answer's `signature` with the Business private token, over the
 * expected amount and the id the read named. Never throws; a null signature is `unsigned`.
 */
export function verifyLydiaStateSignature(
  lookup: CheckoutRequestLookup,
  expectedAmountCents: number,
  businessKey: string,
  signature: string | null
): Exclude<RequestStateVerification, 'no-key'> {
  if (signature === null) return 'unsigned';
  return verifyLydiaSignature(
    lydiaStateSignedFields(lookup, expectedAmountCents),
    businessKey,
    signature
  )
    ? 'verified'
    : 'mismatch';
}
