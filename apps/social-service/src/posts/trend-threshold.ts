/**
 * HOW MANY DISTINCT ACCOUNTS make a post take off (engagement WP-10, decision 5c), AS A SETTING.
 *
 * The default, {@link TREND_THRESHOLD_DEFAULT}, is production's value: the smallest integer at which
 * the posts crossing over 90 days are at most one per three days per campus (docs/wiki/engagement.md,
 * "R1 - the trend threshold"; lead's decision of 2026-11-10, 4 before it). `CAMPUS_TREND_THRESHOLD`
 * overrides it so the dev estate can lower it: the bench has four accounts, and a reading that needs
 * ten distinct likers could not be staged there (owner, 2026-11-16). Production sets nothing.
 *
 * A value that is set and is not a positive integer is a configuration error, and the service
 * refuses to start (`assertTrendThresholdConfigured`, called first thing by `main.ts`): a typo never
 * silently means the default, nor "every post is a trend". A change announces nothing already past
 * it (the crossing rule in `campus-trend.ts`). Read from the environment on every call, so a test
 * can set it.
 */

/** The environment variable holding the threshold. */
export const TREND_THRESHOLD_ENV = 'CAMPUS_TREND_THRESHOLD';

/** Production's threshold: what the service runs with when nothing is configured. */
export const TREND_THRESHOLD_DEFAULT = 10;

/**
 * The threshold a raw `CAMPUS_TREND_THRESHOLD` names: the default when unset or blank, otherwise a
 * positive integer. THROWS on anything else, naming the variable and the value.
 */
export function parseTrendThreshold(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return TREND_THRESHOLD_DEFAULT;
  if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < 1) {
    throw new Error(`${TREND_THRESHOLD_ENV} must be a positive integer, got "${raw}"`);
  }
  return Number(trimmed);
}

/** The threshold this process runs with, read from the environment now. */
export function trendThreshold(): number {
  return parseTrendThreshold(process.env[TREND_THRESHOLD_ENV]);
}

/** Reads the threshold once at boot, so a bad value stops the service before it serves. */
export function assertTrendThresholdConfigured(): number {
  return trendThreshold();
}
