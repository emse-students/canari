/**
 * The rules of a boutique checkout attempt, as data and pure functions (migration 101,
 * docs/wiki/frontend/modules/payments.md "A product checkout is a row, one per attempt").
 */

/**
 * How long a product's Lydia request stays payable, in whole seconds (Lydia's `expire_time`). Set
 * so an abandoned attempt CLOSES at Lydia rather than staying payable for ever at the price of the
 * day it was opened: a request sent without one was still open at the end of a measured session.
 */
export const PRODUCT_REQUEST_LIFETIME_SECONDS = 30 * 60;

/**
 * How long after it was written an open attempt that names NO request may still be the one being
 * issued: social-service's call to core gives up after 120 s (`HttpModule` timeout), so past this the
 * issuing call is over from Canari's side, and the attempt is READ at Lydia by its order_ref instead
 * of waited on - found, it is settled like any other; not found, it never reached Lydia.
 */
export const CHECKOUT_ISSUE_WINDOW_MS = 3 * 60_000;

/**
 * How long past its `expiresAt` an attempt whose request Canari cannot show closed (the read fails,
 * the paying account lost its vendor token, Lydia still answers open) stops blocking its buyer.
 * `expiresAt` is computed BEFORE request/do, so Lydia's own expiry - `expire_time` counted from the
 * request's creation - falls a little after it; this margin covers that. Past it the request was
 * sent an expire_time that has run out, so the attempt is closed `expired` at ERROR. A payment Lydia
 * took before then is still recorded: its confirm callback finds the attempt by id and reads Lydia.
 */
export const CHECKOUT_EXPIRY_MARGIN_MS = 5 * 60_000;

/**
 * The `code` of the 409 a checkout gets while the buyer's previous attempt of this product is still
 * payable, or its fate cannot be shown: issuing a second would leave two payable requests. It lasts
 * at most `PRODUCT_REQUEST_LIFETIME_SECONDS` + `CHECKOUT_EXPIRY_MARGIN_MS` (35 minutes) after that
 * attempt was opened, which is what the shop's sentence says.
 */
export const PREVIOUS_CHECKOUT_OPEN = 'PREVIOUS_CHECKOUT_OPEN';

/** The `code` of the 409 a checkout gets when its buyer already bought this non-repeatable product. */
export const PRODUCT_ALREADY_PURCHASED = 'PRODUCT_ALREADY_PURCHASED';

/**
 * The `code` of the 409 a checkout of a cotisation tier gets when its buyer holds, ACTIVE, a sibling
 * tier whose product price is greater than or equal to it: the sibling XOR would replace the held
 * tier, a silent downgrade (or a sideways swap paid in full). Holding that very tier answers
 * `PRODUCT_ALREADY_PURCHASED` instead.
 */
export const TIER_NOT_A_RISE = 'TIER_NOT_A_RISE';

/**
 * The `code` of the 409 a checkout of a cotisation tier gets when its buyer holds a sibling tier and
 * one of the two has no fixed price (a grid or a free amount): no rank can be established, and the
 * sibling XOR would replace the held tier.
 */
export const TIER_NOT_RANKABLE = 'TIER_NOT_RANKABLE';

/**
 * The `code` of the 409 a manager gets when deleting a cotisation tier that people still hold,
 * active: the body carries `holderCount` beside it. Deleting it would leave their tag naming no
 * tier, so the manager moves them first (a manual grant of another tier swaps it out, a retag
 * renames it, a revoke removes it). The guard is `ProductsService.delete`.
 */
export const TIER_HAS_HOLDERS = 'TIER_HAS_HOLDERS';

/**
 * The `code` of the 409 a manager gets when deleting a cotisation tier while one of its checkout
 * attempts may still be paid (at most `PRODUCT_REQUEST_LIFETIME_SECONDS` + `CHECKOUT_EXPIRY_MARGIN_MS`
 * after it opened): deleted then, that payment could deliver nothing and a refund would be owed.
 */
export const TIER_CHECKOUT_OPEN = 'TIER_CHECKOUT_OPEN';

/**
 * The `code` of the 409 a checkout gets while another attempt of the same buyer and product is being
 * issued right now (a double click): issuing a second would leave two payable requests.
 */
export const CHECKOUT_IN_PROGRESS = 'CHECKOUT_IN_PROGRESS';

/**
 * The Lydia `order_ref` of one attempt: `product:<productId>:<checkoutId>`, 81 characters. Unique
 * PER ATTEMPT because Lydia refuses a second request/do carrying an order_ref it has already seen
 * (error 3, measured on dev 2026-10-21). The buyer is not in it: the attempt row holds the buyer,
 * and the string stays inside the 109 characters Lydia was measured to accept. It is also how an
 * attempt whose issuing call never answered a uuid is READ at Lydia (`request/state` by order_ref).
 * Parsed back by core-service's `parseLydiaOrderRef`, the other half of this grammar.
 */
export function productOrderRef(productId: string, checkoutId: string): string {
  return `product:${productId}:${checkoutId}`;
}

/**
 * Adds the attempt to a return URL, so the page the payer lands on can ask about THIS attempt:
 * `checkout_id`, and the `association_id` + `productId` its confirm route is addressed by (the
 * product may have left the listing by the time the payer returns). Lydia fills nothing into a
 * return URL, and the attempt's id exists before its request does. Works on the web return and on
 * the `fr.emse.canari://payment/...` deep link alike.
 */
export function withCheckoutReturnKey(
  url: string,
  attempt: { checkoutId: string; associationId: string; productId: string }
): string {
  const u = new URL(url);
  u.searchParams.set('checkout_id', attempt.checkoutId);
  u.searchParams.set('association_id', attempt.associationId);
  u.searchParams.set('productId', attempt.productId);
  return u.toString();
}

/**
 * The `code` of the 409 a checkout gets when the association's payment routing (its own account,
 * or an approved parent's) changed between the moment it was resolved - before the buyer's tier
 * lock, since it calls another service - and the moment the attempt is written under that lock.
 */
export const PAYMENT_ROUTING_CHANGED = 'PAYMENT_ROUTING_CHANGED';

/**
 * The `code` of the 409 a checkout gets when its product's price grid came to depend on the buyer's
 * profile (promo, formation) between the moment the purchase was prepared - before the buyer's tier
 * lock, where the profile is fetched since it calls another service - and the moment it is priced
 * under that lock. Nothing is opened; trying again fetches what the grid now needs.
 */
export const PURCHASE_PRICING_CHANGED = 'PURCHASE_PRICING_CHANGED';
