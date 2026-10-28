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
