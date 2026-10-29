const UUID_RE_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * What an `order_ref` Canari itself generated for a Lydia `request/do` call identifies - see
 * `product-checkout.ts`/`form-order-ref.ts` in social-service, the only writers of this format.
 * A product's names the ATTEMPT (`checkoutId`, the `product_checkouts` row), because Lydia refuses
 * a second request/do with an order_ref it has already seen (error 3, measured on dev 2026-10-21):
 * one string per product and buyer made every product unbuyable after one attempt. The buyer is
 * NOT in it: the attempt row holds the buyer, and nothing may take one from a callback.
 * A form's carries a per-request attempt id for the same reason, but only the SUBMISSION is
 * returned: social-service settles the row from its own stored request, so the attempt decides
 * nothing and a callback about an older attempt still names the right row.
 */
export type LydiaOrderRef =
  | { kind: 'form'; submissionId: string }
  | { kind: 'product'; productId: string; checkoutId: string };

/**
 * Parses Canari's own `order_ref` encoding back into what it identifies. Returns null for
 * anything that doesn't match exactly - a malformed or foreign `order_ref` must never be guessed
 * at, since it drives which submission/purchase gets marked paid.
 *
 * The product grammar is `product:<productId uuid>:<checkoutId uuid>` (81 characters, inside the
 * 109 Lydia was measured to accept). The `product:<productId>:<userId>` of before migration 101 had
 * a 64-character hex user id in second place, which this does not match, so no request issued
 * with it parses - as none ever did: the old parser demanded a UUID there, which no user of this
 * estate has. And a uuid in second place is only ever looked up as an attempt row: one that names
 * no stored attempt settles nothing.
 *
 * The form grammar is `form:<submissionId>:<8 hex digits>` since one order_ref is issued per
 * request (social-service `formOrderRef`), and the legacy `form:<submissionId>` of the requests
 * issued before that still parses: a request open at the deploy keeps calling back with it.
 */
export function parseLydiaOrderRef(orderRef: string | null | undefined): LydiaOrderRef | null {
  if (!orderRef) return null;
  const formMatch = /^form:([a-zA-Z0-9_-]{1,128})(?::[0-9a-f]{8})?$/.exec(orderRef);
  if (formMatch) return { kind: 'form', submissionId: formMatch[1] };
  const productMatch = new RegExp(`^product:(${UUID_RE_PART}):(${UUID_RE_PART})$`, 'i').exec(
    orderRef
  );
  if (productMatch) {
    return { kind: 'product', productId: productMatch[1], checkoutId: productMatch[2] };
  }
  return null;
}
