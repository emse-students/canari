import { m } from '$lib/paraglide/messages';
import { SocialApiError, type ClosingGrantRefusal } from '$lib/associations/api';

/** The body `code` of the 409 a closing gets when the payment is not marked "not granted". */
export const PURCHASE_NOT_CLOSABLE = 'PURCHASE_NOT_CLOSABLE';

/** The body `code` of the 409 a second closing of one payment gets: the first outcome stands. */
export const PURCHASE_ALREADY_CLOSED = 'PURCHASE_ALREADY_CLOSED';

/**
 * The body `code` of the 409 a "granted" closing gets when the row is no longer what the list showed
 * (already delivered, or not any more): nothing was written, the list is re-read.
 */
export const PURCHASE_CLOSING_CHANGED = 'PURCHASE_CLOSING_CHANGED';

/**
 * The body `code` of each 409 a "granted" closing gets, by the reason the server refused it
 * (`ClosingGrantRefusal`, the same reason the purchases list carries): nothing was written, and the
 * payment can still be recorded as refunded.
 */
export const GRANT_REFUSAL_CODES: Record<ClosingGrantRefusal, string> = {
  'buyer-erased': 'PURCHASE_BUYER_ERASED',
  'tier-gone': 'PURCHASE_TIER_GONE',
  'year-over': 'PURCHASE_YEAR_OVER',
  'target-held': 'PURCHASE_TARGET_ALREADY_HELD',
  'not-a-rise': 'PURCHASE_NOT_A_RISE',
  'not-comparable': 'PURCHASE_TIER_NOT_COMPARABLE',
};

/** The sentence saying why a payment can only be refunded, shown on its row and on a refusal. */
export function grantRefusalMessage(refusal: ClosingGrantRefusal): string {
  switch (refusal) {
    case 'buyer-erased':
      return m.asso_achats_close_buyer_erased();
    case 'tier-gone':
      return m.asso_achats_close_tier_gone();
    case 'year-over':
      return m.asso_achats_close_year_over();
    case 'target-held':
      return m.asso_achats_close_target_held();
    case 'not-a-rise':
      return m.asso_achats_close_not_a_rise();
    case 'not-comparable':
      return m.asso_achats_close_not_comparable();
  }
}

/**
 * The sentence for a refused closing of a payment paid for and not granted, classified by the typed
 * `code` social-service sets (`product-checkout.ts`), never by its message; the generic sentence for
 * anything else.
 */
export function closingRefusalMessage(err: unknown): string {
  const code = err instanceof SocialApiError ? err.code : null;
  if (code === PURCHASE_ALREADY_CLOSED) return m.asso_achats_close_already();
  if (code === PURCHASE_NOT_CLOSABLE) return m.asso_achats_close_not_closable();
  if (code === PURCHASE_CLOSING_CHANGED) return m.asso_achats_close_changed();
  const refusal = (Object.keys(GRANT_REFUSAL_CODES) as ClosingGrantRefusal[]).find(
    (r) => GRANT_REFUSAL_CODES[r] === code
  );
  return refusal ? grantRefusalMessage(refusal) : m.asso_achats_close_error();
}
