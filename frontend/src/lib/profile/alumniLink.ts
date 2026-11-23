/**
 * THE ALUMNI LINK REMINDER (D44, docs/wiki/profiles-and-access.md "WP8 re-decided").
 *
 * For promo P (the entry year of a cursus), an account with no Alumni link is reminded from
 * 1 September P+1; MiConnect itself blocks from 1 February P+2 (its own stage, not Canari's). Canari
 * draws the skippable half as a banner, from two facts the server serves on the reader's own
 * profile: the cursus, and `alumniLinked` - the `alumni_linked` claim of the last sign-in.
 */
import type { CursusEntry } from './miconnectProfile';

/** The page of MiConnect's user settings where a source (the Alumni one) is linked. */
export const MICONNECT_SOURCES_SETTINGS_PATH = '/if/user/#/settings;page-sources';

/**
 * The first day the reminder is due for an entry year: 1 September of the following year, LOCAL
 * midnight - the school's calendar, not UTC.
 */
export function alumniReminderStart(promo: number): Date {
  return new Date(promo + 1, 8, 1);
}

/**
 * Whether the banner is owed to this reader on `now`.
 *
 * - `alumniLinked` must be an explicit `false`: `true` is done, and `null`/absent is UNKNOWN (a
 *   MiConnect that does not emit the claim yet, a profile cached before it) - never a reason to nag;
 * - the EARLIEST promo of the cursus decides, so a person with two cursus is reminded by the first
 *   one that is due; a person with no cursus (staff, a post only) is never reminded.
 *
 * `now` is a parameter, never read here: the rule is tested on fixed dates.
 */
export function alumniLinkReminderDue(
  profile: { cursus?: CursusEntry[]; alumniLinked?: boolean | null },
  now: Date
): boolean {
  if (profile.alumniLinked !== false) return false;
  const promos = (profile.cursus ?? []).map((c) => c.promo).filter((p) => Number.isInteger(p));
  if (promos.length === 0) return false;
  return now.getTime() >= alumniReminderStart(Math.min(...promos)).getTime();
}

/** MiConnect's sources settings page under `base` (the configured MiConnect URL), or null. */
export function miconnectSourcesSettingsUrl(base: string): string | null {
  const root = base.trim().replace(/\/+$/, '');
  return root ? `${root}${MICONNECT_SOURCES_SETTINGS_PATH}` : null;
}
