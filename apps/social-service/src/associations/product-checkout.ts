/**
 * The rules of a boutique checkout attempt, as data and pure functions (migration 101,
 * docs/wiki/frontend/modules/payments.md "A product checkout is a row, one per attempt").
 */
import { LYDIA_REQUEST_UUID_RE } from '../forms/seat-hold';

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
 * The `code` of the 409 a checkout or a cash sale of a membership product gets while its
 * association has no cotisation mode: no tier tag can be derived, so nothing would be granted for
 * the money. Refused before any payment is requested or recorded.
 */
export const COTISATION_DISABLED = 'COTISATION_DISABLED';

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
 * Which request a state read of this attempt names, as core-service's `payments/request-state`
 * takes it: the `request_uuid` the issuing call answered, or - for an attempt whose issuing call
 * never answered one - its order_ref (`productOrderRef`), which Lydia's `request/state` also finds.
 * The ONE choice, made for the payer's return, the confirm callback and the reconciliation sweep.
 */
export function productCheckoutLookup(attempt: {
  id: string;
  productId: string;
  requestUuid: string | null;
}): { sessionId: string } | { orderRef: string } {
  return attempt.requestUuid && LYDIA_REQUEST_UUID_RE.test(attempt.requestUuid)
    ? { sessionId: attempt.requestUuid }
    : { orderRef: productOrderRef(attempt.productId, attempt.id) };
}

/**
 * The `code` of the 409 a checkout gets when its product's price grid came to depend on the buyer's
 * profile (promo, formation) between the moment the purchase was prepared - before the buyer's tier
 * lock, where the profile is fetched since it calls another service - and the moment it is priced
 * under that lock. Nothing is opened; trying again fetches what the grid now needs.
 */
export const PURCHASE_PRICING_CHANGED = 'PURCHASE_PRICING_CHANGED';

/**
 * The `code` of the 409 a closing gets when the purchase record is not marked `paid_not_granted`:
 * only a tier paid for and not granted is owed an outcome (docs/wiki/cotisations.md "Rising to a
 * higher tier").
 */
export const PURCHASE_NOT_CLOSABLE = 'PURCHASE_NOT_CLOSABLE';

/**
 * The `code` of the 409 a closing gets when that payment's outcome was already recorded: a payment
 * is closed once (the unique index of migration 113), and the first outcome stands.
 */
export const PURCHASE_ALREADY_CLOSED = 'PURCHASE_ALREADY_CLOSED';

/**
 * The `code` of the 409 a closing as `granted` gets when the tier the payment was for can no longer
 * be granted: its product was deleted or is no longer a tier, or its form no longer grants one.
 * Nothing is written; the payment can still be closed as `refunded`.
 */
export const PURCHASE_TIER_GONE = 'PURCHASE_TIER_GONE';

/**
 * The `code` of the 409 a closing as `granted` gets when the buyer's account was erased: every
 * erased account shares one id, so a grant would make a cotisant of nobody. `refunded` stays open.
 */
export const PURCHASE_BUYER_ERASED = 'PURCHASE_BUYER_ERASED';

/**
 * The `code` of the 409 a closing as `granted` gets when the buyer ALREADY holds the tier paid for:
 * the payment bought nothing, so a refund is the outcome owed; granting would only renew the tier
 * and take the payment off the report while the refund is still owed.
 */
export const PURCHASE_TARGET_ALREADY_HELD = 'PURCHASE_TARGET_ALREADY_HELD';

/**
 * The `code` of the 409 a closing as `granted` gets when what the list showed is no longer what the
 * closing would do: the list said the tier is already delivered ("nothing is granted") and it no
 * longer is, or the reverse. Nothing was written; the list is re-read, then the manager decides again.
 */
export const PURCHASE_CLOSING_CHANGED = 'PURCHASE_CLOSING_CHANGED';

/**
 * The `code` of the 409 a closing as `granted` gets when the buyer holds a tier the one paid for is
 * not a rise over (worth as much or more, or not comparable): granting would move them down. A
 * refund is the outcome left.
 */
export const PURCHASE_NOT_A_RISE = 'PURCHASE_NOT_A_RISE';

/**
 * The `code` of the 409 a closing as `granted` gets when the payment was for an academic year that
 * is over (a `dated` association): the tier it bought cannot be granted any more, only refunded.
 */
export const PURCHASE_YEAR_OVER = 'PURCHASE_YEAR_OVER';

/**
 * The `code` of the 409 a closing as `granted` gets when the tier paid for or the tier the buyer
 * holds has no fixed price (a grid or a free amount): the two cannot be ranked, so the grant cannot
 * be told from a move down. A refund is the outcome left.
 */
export const PURCHASE_TIER_NOT_COMPARABLE = 'PURCHASE_TIER_NOT_COMPARABLE';
