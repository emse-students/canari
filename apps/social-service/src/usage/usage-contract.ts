/**
 * THE USAGE DASHBOARD'S SHARED FACTS, this service's copy (docs/wiki/usage-dashboard.md). Every value
 * here is pinned by `libs/contracts/usage-dashboard.json`, which chat-gateway (`usage.rs`, the
 * writer of the people keys) and chat-delivery-service (`utils/usage-activity.ts`) read too - a key
 * spelled differently on one side would be a figure silently read as zero on the other.
 */

/** Every key of the dashboard starts with this. */
export const USAGE_KEY_PREFIX = 'usage:';

/** The seven buckets a person is counted in, in the gateway's order (`usage::CATEGORIES`). */
export const USAGE_CATEGORIES = [
  'app_android',
  'app_ios',
  'app_desktop',
  'web_android',
  'web_ios',
  'web_desktop',
  'other',
] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

/** The daily activity totals (owner, 2026-11-16): per Paris day only, for the whole platform. */
export const USAGE_ACTIVITY_METRICS = [
  'messages',
  'posts',
  'reels',
  'lives',
  'calls',
  'forms',
] as const;
export type UsageActivityMetric = (typeof USAGE_ACTIVITY_METRICS)[number];

/** A day's keys live 40 days; the fold reads the last {@link USAGE_FOLD_DAYS} of them. */
export const USAGE_DAY_KEY_TTL_SECS = 40 * 24 * 60 * 60;
/** An hour's key lives 30 days; the hour map reads the {@link USAGE_HOUR_MAP_DAYS} before today. */
export const USAGE_HOUR_KEY_TTL_SECS = 30 * 24 * 60 * 60;
/**
 * Days the fold re-reads (today included): a 31-day month stays foldable for a week after it ends,
 * and every key it reads still lives (40 days).
 */
export const USAGE_FOLD_DAYS = 38;
/** Days the week-by-hour map averages: four whole weeks. */
export const USAGE_HOUR_MAP_DAYS = 28;

/** A day's distinct people: `usage:people:{day}`. */
export const peopleKey = (day: string) => `${USAGE_KEY_PREFIX}people:${day}`;
/** A day's people in one category. */
export const peopleCategoryKey = (day: string, category: string) =>
  `${peopleKey(day)}:cat:${category}`;
/** A day's people on one version. */
export const peopleVersionKey = (day: string, version: string) =>
  `${peopleKey(day)}:ver:${version}`;
/** The set of versions a day has a key for (bounded by the gateway's script). */
export const peopleVersionsKey = (day: string) => `${peopleKey(day)}:versions`;
/** One Paris hour's distinct people: `usage:people:h:{day}T{HH}`. */
export const peopleHourKey = (day: string, hour: number) =>
  `${USAGE_KEY_PREFIX}people:h:${day}T${String(hour).padStart(2, '0')}`;
/** One Paris day's activity counters (a hash, one field per metric). */
export const activityKey = (day: string) => `${USAGE_KEY_PREFIX}activity:${day}`;
