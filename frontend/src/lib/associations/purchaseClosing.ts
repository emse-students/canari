import { m } from '$lib/paraglide/messages';
import { SocialApiError } from '$lib/associations/api';

/** The body `code` of the 409 a closing gets when the payment is not marked "not granted". */
export const PURCHASE_NOT_CLOSABLE = 'PURCHASE_NOT_CLOSABLE';

/** The body `code` of the 409 a second closing of one payment gets: the first outcome stands. */
export const PURCHASE_ALREADY_CLOSED = 'PURCHASE_ALREADY_CLOSED';

/**
 * The body `code` of the 409 a "granted" closing gets when the tier the payment was for no longer
 * exists: nothing was written, and the payment can still be recorded as refunded.
 */
export const PURCHASE_TIER_GONE = 'PURCHASE_TIER_GONE';

/**
 * The sentence for a refused closing of a payment paid for and not granted, classified by the typed
 * `code` social-service sets (`product-checkout.ts`), never by its message; the generic sentence for
 * anything else.
 */
export function closingRefusalMessage(err: unknown): string {
  const code = err instanceof SocialApiError ? err.code : null;
  if (code === PURCHASE_ALREADY_CLOSED) return m.asso_achats_close_already();
  if (code === PURCHASE_NOT_CLOSABLE) return m.asso_achats_close_not_closable();
  if (code === PURCHASE_TIER_GONE) return m.asso_achats_close_tier_gone();
  return m.asso_achats_close_error();
}
