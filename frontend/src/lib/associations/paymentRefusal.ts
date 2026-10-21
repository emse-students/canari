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
  return null;
}

/**
 * The body `code` of a refusal because the amount is outside what can be paid (the provider's
 * range, or a product's own bounds). Mirrors social-service's `core-payment-error.ts`; its
 * `minCents` / `maxCents` ride beside it and become {@link SocialApiError.amountBounds}.
 */
export const AMOUNT_OUT_OF_RANGE = 'AMOUNT_OUT_OF_RANGE';

/**
 * The body `code` of social-service's 409 when a form answer's previous payment request could not
 * be shown dead or paid, so no second one was issued (`seat-hold.ts`). It can last until that
 * request's 30-minute hold ends - counted from when it was issued, and for a row older than
 * migration 084 from when the answer was created - so the sentence names that bound rather than
 * "a moment", and is localized rather than echoing the server's English.
 */
export const PREVIOUS_PAYMENT_OPEN = 'PREVIOUS_PAYMENT_OPEN';
