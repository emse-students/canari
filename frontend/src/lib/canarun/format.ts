/**
 * CanaRun - how a checked {@link RunActivity} is WORDED: the sport's name, its units (pace in
 * min/km for running and hiking, km/h for cycling, metres for a pool swim) and localised numbers.
 *
 * Pure strings from a checked activity, so the card, the conversation preview and the tests read
 * one wording. Every sentence is Paraglide; only the digits come from `Intl`.
 */

import { getLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { RunActivity, RunSportName } from './activity';

/** `fr-FR` / `en-US`, the pair the rest of the app formats numbers and dates with. */
function intlLocale(): string {
  return getLocale() === 'en' ? 'en-US' : 'fr-FR';
}

/** The sport's localised name. */
export function runSportLabel(sport: RunSportName): string {
  switch (sport) {
    case 'running':
      return m.canarun_sport_running();
    case 'cycling':
      return m.canarun_sport_cycling();
    case 'hiking':
      return m.canarun_sport_hiking();
    case 'pool-swim':
      return m.canarun_sport_pool_swim();
    case 'unspecified':
      return m.canarun_sport_unspecified();
  }
}

/**
 * The distance with its unit: metres for a pool swim (lengths are counted in metres), kilometres
 * otherwise - two decimals under 10 km, one above, as the activity apps print it.
 */
export function formatRunDistance(activity: Pick<RunActivity, 'sport' | 'distanceM'>): string {
  if (activity.sport === 'pool-swim') {
    return m.canarun_distance_m({
      distance: new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0 }).format(
        activity.distanceM
      ),
    });
  }
  const km = activity.distanceM / 1000;
  const digits = km < 10 ? 2 : 1;
  return m.canarun_distance_km({
    distance: new Intl.NumberFormat(intlLocale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(km),
  });
}

/** `h:mm:ss`, or `m:ss` under an hour - the clock form every activity app uses. */
export function formatRunDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
}

/** The time a rate is measured over: time in motion when the sender recorded it, else elapsed. */
function rateSeconds(activity: Pick<RunActivity, 'movingS' | 'durationS'>): number {
  return activity.movingS > 0 ? activity.movingS : activity.durationS;
}

/**
 * The rate the sport is read in, labelled - pace (min/km) for running and hiking, speed (km/h) for
 * cycling, nothing for a pool swim or an unspecified sport (no unit was decided for them), and
 * nothing when distance or time is zero (a rate of nothing is not a rate).
 */
export function formatRunRate(
  activity: Pick<RunActivity, 'sport' | 'distanceM' | 'movingS' | 'durationS'>
): { label: string; value: string } | null {
  const seconds = rateSeconds(activity);
  if (activity.distanceM <= 0 || seconds <= 0) return null;
  if (activity.sport === 'running' || activity.sport === 'hiking') {
    const secondsPerKm = seconds / (activity.distanceM / 1000);
    return {
      label: m.canarun_stat_pace(),
      value: m.canarun_pace_value({ pace: formatRunDuration(secondsPerKm) }),
    };
  }
  if (activity.sport === 'cycling') {
    const kmh = activity.distanceM / 1000 / (seconds / 3600);
    return {
      label: m.canarun_stat_speed(),
      value: m.canarun_speed_value({
        speed: new Intl.NumberFormat(intlLocale(), {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(kmh),
      }),
    };
  }
  return null;
}

/** The elevation gain, or `null` when there is none to state or the sport has none (a pool). */
export function formatRunElevation(
  activity: Pick<RunActivity, 'sport' | 'elevationGainM'>
): string | null {
  if (activity.sport === 'pool-swim' || activity.elevationGainM <= 0) return null;
  return m.canarun_elevation_value({
    elevation: new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0 }).format(
      activity.elevationGainM
    ),
  });
}

/** The start, as a localised date and time. */
export function formatRunStart(startedAt: number): string {
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(startedAt)
  );
}

/** One line for a conversation list or a quoted reply: the sport and the distance. */
export function runSummary(activity: Pick<RunActivity, 'sport' | 'distanceM'>): string {
  const sport = runSportLabel(activity.sport);
  return activity.distanceM > 0
    ? m.canarun_summary({ sport, distance: formatRunDistance(activity) })
    : sport;
}
