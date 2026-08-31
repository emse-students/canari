import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';

/**
 * The values a criterion can be built from, and how each is offered to a manager.
 *
 * `formation` comes from Authentik and the next value arrives with no deploy, so the picker offers
 * what EXISTS. A promo is a year and needs nothing fetched: the domain is fixed and known.
 */

/** A formation in use, with how many people carry it. */
export interface FormationOption {
  value: string;
  count: number;
}

/** Formation values in use. Throws when the listing cannot be read - the caller shows the error. */
export async function fetchFormations(): Promise<FormationOption[]> {
  const res = await apiFetch(`${socialUrl()}/api/forms/criteria/formations`);
  if (!res.ok) throw new Error('Failed to fetch formations');
  return res.json();
}

/**
 * The school's founding year, and therefore the oldest promo there can be.
 *
 * The server holds the same bound (`FIRST_PROMO_YEAR` in `pricing/validate.ts`) and refuses a year
 * outside it, because a promo outside the range matches nobody FOR EVER - `2O24` typed for `2024`
 * would price a whole cohort as "everyone else", in silence.
 */
export const FIRST_PROMO_YEAR = 1816;

/**
 * Every promo, most recent first.
 *
 * A promo is an ENTRY year - "la promo 2024" entered the school in 2024 - so the last one is the
 * current calendar year and the list needs no round trip. It used to be a five-year window computed
 * from the academic year on the graduation reading, which offered six cohorts nobody belonged to
 * and omitted the three largest that do.
 */
export function promoYears(now: Date = new Date()): number[] {
  const last = lastPromoYear(now);
  return Array.from({ length: last - FIRST_PROMO_YEAR + 1 }, (_, i) => last - i);
}

/**
 * The newest promo there can be: nobody has entered the school in a year that has not started.
 *
 * Named rather than inlined because three things need it - the list, the guard, and the message
 * telling a manager what they may type - and a fourth reading of "the current year" is how they
 * would come to disagree.
 */
export function lastPromoYear(now: Date = new Date()): number {
  return now.getFullYear();
}

/** True when a year is a promo the server will accept. */
export function isPromoYear(year: number, now: Date = new Date()): boolean {
  return Number.isInteger(year) && year >= FIRST_PROMO_YEAR && year <= lastPromoYear(now);
}
