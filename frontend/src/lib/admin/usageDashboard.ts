import { m } from '$lib/paraglide/messages';

/**
 * The usage dashboard's wire shape and the few computations the page makes on it
 * (docs/wiki/usage-dashboard.md). Counts only: no identifier of any kind travels on this wire.
 */

/** Distinct people in a period. */
export interface PeopleFigures {
  all: number;
  categories: Record<string, number>;
  versions: Record<string, number>;
}

/** The six daily activity totals (owner, 2026-11-16): per day only, never finer. */
export const ACTIVITY_METRICS = ['messages', 'posts', 'reels', 'lives', 'calls', 'forms'] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];

/** One period of the answer; `activity` on days only. */
export interface UsagePeriod {
  start: string;
  people: PeopleFigures;
  activity?: Record<ActivityMetric, number>;
}

/** `GET /api/admin/usage`. */
export interface UsageView {
  timeZone: string;
  today: string;
  days: UsagePeriod[];
  weeks: UsagePeriod[];
  months: UsagePeriod[];
  hours: { from: string; to: string; cells: number[][] };
}

/** The seven categories, in the server's order (`libs/contracts/usage-dashboard.json`). */
export const USAGE_CATEGORIES = [
  'app_android',
  'app_ios',
  'app_desktop',
  'web_android',
  'web_ios',
  'web_desktop',
  'other',
] as const;

/** The localized name of a category; one the server adds later is shown as spelled. */
export function categoryLabel(category: string): string {
  switch (category) {
    case 'app_android':
      return m.admin_usage_category_app_android();
    case 'app_ios':
      return m.admin_usage_category_app_ios();
    case 'app_desktop':
      return m.admin_usage_category_app_desktop();
    case 'web_android':
      return m.admin_usage_category_web_android();
    case 'web_ios':
      return m.admin_usage_category_web_ios();
    case 'web_desktop':
      return m.admin_usage_category_web_desktop();
    case 'other':
      return m.admin_usage_category_other();
    default:
      return category;
  }
}

/** The localized name of an activity metric. */
export function activityLabel(metric: ActivityMetric): string {
  switch (metric) {
    case 'messages':
      return m.admin_usage_activity_messages();
    case 'posts':
      return m.admin_usage_activity_posts();
    case 'reels':
      return m.admin_usage_activity_reels();
    case 'lives':
      return m.admin_usage_activity_lives();
    case 'calls':
      return m.admin_usage_activity_calls();
    case 'forms':
      return m.admin_usage_activity_forms();
  }
}

/**
 * The activity of each calendar month, summed from its DAYS (the server stores activity per day
 * only). Only the days the answer carries are summed, so a month older than them has no row.
 */
export function activityByMonth(
  days: UsagePeriod[]
): { start: string; activity: Record<ActivityMetric, number> }[] {
  const months = new Map<string, Record<ActivityMetric, number>>();
  for (const day of days) {
    if (!day.activity) continue;
    const start = `${day.start.slice(0, 8)}01`;
    const sum =
      months.get(start) ??
      (Object.fromEntries(ACTIVITY_METRICS.map((k) => [k, 0])) as Record<ActivityMetric, number>);
    for (const k of ACTIVITY_METRICS) sum[k] += day.activity[k] ?? 0;
    months.set(start, sum);
  }
  return [...months.entries()].map(([start, activity]) => ({ start, activity }));
}

/** The versions of a period, most people first. */
export function versionsOf(period: UsagePeriod | undefined): { version: string; people: number }[] {
  if (!period) return [];
  return Object.entries(period.people.versions)
    .map(([version, people]) => ({ version, people }))
    .sort((a, b) => b.people - a.people || a.version.localeCompare(b.version));
}

/** The largest cell of the hour map (0 when empty), the top of its single-hue scale. */
export function hourMapMax(cells: number[][]): number {
  return cells.reduce((max, row) => Math.max(max, ...row), 0);
}
