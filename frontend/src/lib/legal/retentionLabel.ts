import { m } from '$lib/paraglide/messages';

/**
 * A retention duration as a member reads it: "1 an" for a whole number of years, "{n} jours"
 * otherwise. The number is the server's (`$lib/legal/retention`); this only words it.
 */
export function durationLabel(days: number): string {
  if (days > 0 && days % 365 === 0) return m.reels_lifetime_years({ count: days / 365 });
  return m.reels_lifetime_days({ count: days });
}
