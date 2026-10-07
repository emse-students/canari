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
  return null;
}
