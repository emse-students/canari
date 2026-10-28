import { m } from '$lib/paraglide/messages';
import { SocialApiError } from '$lib/associations/api';
import { formatAmount } from '$lib/forms/fillAnswers';

/** The body `code` social-service sets when the payment provider itself declined a payment. */
export const PAYMENT_PROVIDER_REFUSED = 'PAYMENT_PROVIDER_REFUSED';

/**
 * The sentence for a refusal BY THE PAYMENT PROVIDER, or `null` when `err` is anything else.
 *
 * ONE function for every surface that starts a payment (the shop toast, the form's inline error):
 * a provider refusal (Lydia: blocked venue, bad phone...) is an answer about THIS payment and
 * carries a readable reason, and the reason alone - "Ce lieu n'est pas autorisé" - reads as an
 * unexplained fragment without the sentence that says who said it. Classified by the typed `code`,
 * never by the message.
 */
export function providerRefusalMessage(err: unknown): string | null {
  if (err instanceof SocialApiError && err.code === PAYMENT_PROVIDER_REFUSED) {
    return m.shop_payment_refused({ reason: err.message });
  }
  if (err instanceof SocialApiError && err.code === PREVIOUS_PAYMENT_OPEN) {
    return m.form_previous_payment_open();
  }
  if (err instanceof SocialApiError && err.code === AMOUNT_OUT_OF_RANGE && err.amountBounds) {
    const { minCents, maxCents } = err.amountBounds;
    // In the reader's locale: `formatPriceCents` is pinned to fr-FR, so English read '0,50 EUR'.
    const min = formatAmount(minCents);
    return maxCents === null
      ? m.shop_payment_amount_min({ min })
      : m.shop_payment_amount_range({ min, max: formatAmount(maxCents) });
  }
  if (err instanceof SocialApiError && err.code === ALREADY_ANSWERED) {
    return m.form_already_answered();
  }
  if (err instanceof SocialApiError && err.code === GUEST_PENDING_LIMIT) {
    return m.form_guest_pending_limit();
  }
  if (err instanceof SocialApiError && err.code === PREVIOUS_CHECKOUT_OPEN) {
    return m.shop_previous_checkout_open();
  }
  if (err instanceof SocialApiError && err.code === PRODUCT_ALREADY_PURCHASED) {
    return m.shop_already_purchased();
  }
  if (err instanceof SocialApiError && err.code === TIER_NOT_A_RISE) {
    return m.shop_tier_not_a_rise();
  }
  if (err instanceof SocialApiError && err.code === TIER_NOT_RANKABLE) {
    return m.shop_tier_not_rankable();
  }
  if (err instanceof SocialApiError && err.code === COTISATION_DISABLED) {
    return m.shop_cotisation_disabled();
  }
  if (err instanceof SocialApiError && err.code === FORM_TIER_ALREADY_HELD) {
    return m.form_tier_already_held();
  }
  if (err instanceof SocialApiError && err.code === FORM_TIER_NOT_SOLD) {
    return m.form_tier_not_sold();
  }
  if (err instanceof SocialApiError && err.code === PAYMENT_ROUTING_CHANGED) {
    return m.shop_payment_routing_changed();
  }
  if (err instanceof SocialApiError && err.code === PURCHASE_PRICING_CHANGED) {
    return m.shop_purchase_pricing_changed();
  }
  if (err instanceof SocialApiError && err.code === CHECKOUT_IN_PROGRESS) {
    return m.shop_checkout_in_progress();
  }
  return null;
}

/**
 * The body `code` of a refusal because the amount is outside what can be paid (the provider's
 * range, or a product's own bounds). Mirrors social-service's `core-payment-error.ts`; its
 * `minCents` / `maxCents` ride beside it and become {@link SocialApiError.amountBounds}.
 */
export const AMOUNT_OUT_OF_RANGE = 'AMOUNT_OUT_OF_RANGE';

/**
 * The body `code` of social-service's 409 when a single-answer form already holds an answer for
 * this person (paid, free, cash, or an online one still pending): no second answer is written and
 * no payment is requested (`seat-hold.ts`).
 */
export const ALREADY_ANSWERED = 'ALREADY_ANSWERED';

/**
 * The body `code` of social-service's 429 when one visitor (one network address) already has three
 * paid answers waiting for payment on a public form (`guest-visitor.ts`, decision PP5). The
 * sentence says how the place comes back: a payment, or the 30-minute hold ending.
 */
export const GUEST_PENDING_LIMIT = 'GUEST_PENDING_LIMIT';

/**
 * The body `code` of social-service's 409 when the buyer already bought this non-repeatable
 * product: decided by Canari from its purchase records, before any payment request is issued.
 */
export const PRODUCT_ALREADY_PURCHASED = 'PRODUCT_ALREADY_PURCHASED';

/**
 * The body `code` of social-service's 409 when the buyer holds, active, a sibling cotisation tier
 * priced at least as high as this one: buying it would replace the held tier (`product-checkout.ts`).
 */
export const TIER_NOT_A_RISE = 'TIER_NOT_A_RISE';

/**
 * The body `code` of social-service's 409 when the buyer holds a sibling cotisation tier and one of
 * the two has no fixed price (a grid or a free amount), so no rank can be established online.
 */
export const TIER_NOT_RANKABLE = 'TIER_NOT_RANKABLE';

/**
 * The body `code` of social-service's 409 when a membership product is bought (or sold for cash)
 * while its association's cotisations are disabled: nothing could be granted, so nothing is taken.
 */
export const COTISATION_DISABLED = 'COTISATION_DISABLED';

/**
 * The body `code` of social-service's 409 when a paid answer's form grants the cotisation tier the
 * submitter already holds (`tier-pricing.ts`): a form words it apart from a product already bought.
 */
export const FORM_TIER_ALREADY_HELD = 'FORM_TIER_ALREADY_HELD';

/**
 * The body `code` of social-service's 409 when a paid answer's form grants a cotisation tier that
 * no longer exists (its product was deleted): refused to everybody, a holder of no membership included, so the
 * sentence speaks of the form, not of the submitter's membership.
 */
export const FORM_TIER_NOT_SOLD = 'FORM_TIER_NOT_SOLD';

/**
 * The body `code` of social-service's 409 when the association's payment account changed while
 * the checkout was being opened: nothing was opened, and trying again uses the new account.
 */
export const PAYMENT_ROUTING_CHANGED = 'PAYMENT_ROUTING_CHANGED';

/**
 * The body `code` of social-service's 409 when the product's price grid came to depend on the
 * buyer's profile while the checkout was being opened: nothing was opened, and trying again prices
 * it from the profile it now needs.
 */
export const PURCHASE_PRICING_CHANGED = 'PURCHASE_PRICING_CHANGED';

/**
 * The body `code` of the 409 a boutique checkout gets while the buyer's previous attempt of that
 * product is still payable or unproven (`product-checkout.ts`). social-service stops refusing 35
 * minutes after that attempt was opened (its 30-minute expiry plus a margin), so the sentence says 35.
 */
export const PREVIOUS_CHECKOUT_OPEN = 'PREVIOUS_CHECKOUT_OPEN';

/** The body `code` of the 409 a second click gets while the first one's payment is being opened. */
export const CHECKOUT_IN_PROGRESS = 'CHECKOUT_IN_PROGRESS';

/**
 * The body `code` of social-service's 409 when a form answer's previous payment request could not
 * be shown dead or paid, so no second one was issued (`seat-hold.ts`). It can last until that
 * request's 30-minute hold ends - counted from when it was issued, and for a row older than
 * migration 084 from when the answer was created - so the sentence names that bound rather than
 * "a moment", and is localized rather than echoing the server's English.
 */
export const PREVIOUS_PAYMENT_OPEN = 'PREVIOUS_PAYMENT_OPEN';
