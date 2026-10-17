import { m } from '$lib/paraglide/messages';
import { SocialApiError } from '$lib/associations/api';

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
  return null;
}

/**
 * The body `code` of social-service's 409 when a form answer's previous payment request could not
 * be shown dead or paid, so no second one was issued (`seat-hold.ts`). It can last until that
 * request's 30-minute hold ends - counted from when it was issued, and for a row older than
 * migration 084 from when the answer was created - so the sentence names that bound rather than
 * "a moment", and is localized rather than echoing the server's English.
 */
export const PREVIOUS_PAYMENT_OPEN = 'PREVIOUS_PAYMENT_OPEN';
