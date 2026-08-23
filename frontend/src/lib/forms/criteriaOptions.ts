import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';
import { m } from '$lib/paraglide/messages';

/**
 * The values a criterion can be built from, and how each is offered to a manager.
 *
 * Nothing here is a hard-coded list of formations or promos. `formation` comes from Authentik and
 * the next value arrives with no deploy, so the picker offers what EXISTS; promos are computed from
 * the academic year, so a relative bucket can show which cohort it means today.
 */

/** A formation in use, with how many people carry it. */
export interface FormationOption {
  value: string;
  count: number;
}

/**
 * The calendar year the current academic year ends in - 2027 from September 2026 to August 2027.
 *
 * The same September rule as the server's `academicEndYear`, which it has to be: a relative promo
 * bucket resolved one way here and another way there would show a manager a cohort that is not the
 * one being charged. Duplicated deliberately rather than fetched - one integer, one rule, and a
 * round trip to learn the date would be worse.
 */
export function academicEndYear(now: Date = new Date()): number {
  return now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear();
}

/** Formation values in use. Throws when the listing cannot be read - the caller shows the error. */
export async function fetchFormations(): Promise<FormationOption[]> {
  const res = await apiFetch(`${socialUrl()}/api/forms/criteria/formations`);
  if (!res.ok) throw new Error('Failed to fetch formations');
  return res.json();
}

/**
 * The relative promo choices: "graduating this year" out to four years away, each labelled with the
 * promo it means today.
 *
 * A study year ("1A") is deliberately NOT offered, because it cannot be derived: it needs a cursus
 * length, and nothing in this platform records one - ICM and ISMIN run three years, Master two. The
 * manager names the group itself, which is the honest division of labour.
 */
export function yearsToGraduationOptions(
  now: Date = new Date()
): { value: string; label: string; hint: string }[] {
  const end = academicEndYear(now);
  return [0, 1, 2, 3, 4].map((n) => ({
    value: String(n),
    label:
      n === 0 ? m.form_criterion_promo_final_year() : m.form_criterion_promo_in_years({ count: n }),
    hint: m.form_criterion_promo_resolves({ promo: end + n }),
  }));
}

/** Absolute promo choices: last year through five years out, which covers every live cohort. */
export function graduationYearOptions(now: Date = new Date()): { value: string; label: string }[] {
  const end = academicEndYear(now);
  return [-1, 0, 1, 2, 3, 4, 5].map((n) => ({
    value: String(end + n),
    label: String(end + n),
  }));
}
