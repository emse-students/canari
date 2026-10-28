import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';

/**
 * The body `code` of social-service's 400 when a cotisation tier is created or renamed with a key
 * that is, or ends with, an academic year (`2024-2025`): its tag would be the name of another
 * tier's dated tag (`ProductsService.assertVariantKeyFree`).
 */
export const TIER_KEY_YEAR_SHAPED = 'TIER_KEY_YEAR_SHAPED';

/**
 * The sentence for a tier creation or save the server refused because of the KEY chosen, or `null`
 * when `err` is anything else (the caller then shows its generic sentence). Classified by the typed
 * `code`, never by the server's English.
 */
export function tierKeyRefusalMessage(err: unknown): string | null {
  if (err instanceof SocialApiError && err.code === TIER_KEY_YEAR_SHAPED) {
    return m.asso_cotisations_tier_key_year_shaped();
  }
  return null;
}

/**
 * The body `code` of social-service's 400 when a product's `memberPriceTag` ("Tarif preferentiel
 * depuis") names no OTHER cotisation tier of the product's own association (another association's
 * tag, a non-tier tag, the tier itself): such a link would price nothing, so the save is refused
 * (`tier-pricing.ts`, `ProductsService`).
 */
export const MEMBER_PRICE_TAG_NOT_A_TIER = 'MEMBER_PRICE_TAG_NOT_A_TIER';

/**
 * The sentence for a tier save refused because its preferential-price link names no other tier of
 * the association, or `null` when `err` is anything else. Classified by the typed `code`.
 */
export function memberPriceTagRefusalMessage(err: unknown): string | null {
  if (err instanceof SocialApiError && err.code === MEMBER_PRICE_TAG_NOT_A_TIER) {
    return m.asso_cotisations_member_price_tag_not_a_tier();
  }
  return null;
}

/**
 * Why a tier creation or save was refused by something the manager chose - the KEY
 * (`tierKeyRefusalMessage`) or the preferential-price link (`memberPriceTagRefusalMessage`) - as the
 * sentence to show and the `code` to log, or `null` for any other failure (the caller keeps its
 * generic sentence and logs the error). ONE call for both tier forms, so neither forgets a code.
 */
export function tierSaveRefusal(err: unknown): { code: string; message: string } | null {
  const message = tierKeyRefusalMessage(err) ?? memberPriceTagRefusalMessage(err);
  if (message === null || !(err instanceof SocialApiError) || err.code === null) return null;
  return { code: err.code, message };
}
