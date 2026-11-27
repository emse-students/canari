import { m } from '$lib/paraglide/messages';
import { compareVersionsDesc, versionLine, type Series } from './presenceSeries';

/**
 * The usage dashboard's wire shape and the few computations the page makes on it
 * (docs/wiki/usage-dashboard.md). Counts only: no identifier of any kind travels on this wire.
 */

/** Distinct people in a period. */
interface PeopleFigures {
  all: number;
  categories: Record<string, number>;
  versions: Record<string, number>;
}

/** The six daily activity totals (owner, 2026-11-16): per day only, never finer. */
export const ACTIVITY_METRICS = ['messages', 'posts', 'reels', 'lives', 'calls', 'forms'] as const;
type ActivityMetric = (typeof ACTIVITY_METRICS)[number];

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
/**
 * The `count` calendar days ending at `today` (`YYYY-MM-DD`, Paris), oldest first, each with its
 * period when the server sent one. A day the server has no row for is kept, with no period, so the
 * chart draws it as a gap - never squeezed out, never a zero it was not told.
 */
export function calendarDays(
  days: UsagePeriod[],
  today: string,
  count: number
): { start: string; period: UsagePeriod | undefined }[] {
  const byStart = new Map(days.map((d) => [d.start, d]));
  const end = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const start = new Date(end - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { start, period: byStart.get(start) };
  });
}

/**
 * The activity of each month the days cover, oldest first. A month is `partial` when any of ITS OWN
 * days, from its first to its last or to `today` for the current month, has no activity row - the
 * oldest month of a 366-day window, a month whose first days were never folded, or one with a hole
 * in the middle: its totals are then what was counted, not the month's.
 */
export function activityByMonth(
  days: UsagePeriod[],
  today: string
): { start: string; partial: boolean; activity: Record<ActivityMetric, number> }[] {
  const counted = new Map<string, number>();
  for (const day of days) {
    if (day.activity && day.start <= today) {
      const start = `${day.start.slice(0, 8)}01`;
      counted.set(start, (counted.get(start) ?? 0) + 1);
    }
  }
  /** How many days of the month starting `start` exist up to `today`. */
  const owed = (start: string) => {
    const [y, mo] = start.split('-').map(Number);
    const inMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return today.startsWith(start.slice(0, 8)) ? Number(today.slice(8, 10)) : inMonth;
  };
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
  return [...months.entries()].map(([start, activity]) => ({
    start,
    partial: (counted.get(start) ?? 0) < owed(start),
    activity,
  }));
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

/** The windows the day charts offer, in days (the server keeps 366 of them). */
export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/** A calendar day of {@link calendarDays}. */
export type CalendarDay = ReturnType<typeof calendarDays>[number];

/** What a line chart of distinct people is split by. */
export type UsageAxis = 'category' | 'version';

/** A day's noon UTC as epoch seconds: the chart's time for it, which no zone can move. */
const dayTime = (start: string) => Date.parse(`${start}T12:00:00Z`) / 1000;

/** The categorical slot of each device type, fixed so a type keeps its colour whatever else is shown. */
const CATEGORY_SLOT: Record<string, number> = Object.fromEntries(
  USAGE_CATEGORIES.map((c, i) => [c, i + 1])
);

/**
 * The line chart's input for a window of days: one line per device type or per version that had
 * somebody in it, and the total as the dashed line. A day with no row is `null` in every line (a
 * gap, never a zero); a day with a row where a key is absent is a real 0.
 */
export function peopleSeries(
  days: readonly CalendarDay[],
  axis: UsageAxis
): { times: number[]; series: Series[]; total: (number | null)[] } {
  const bucketOf = (p: UsagePeriod) =>
    axis === 'category' ? p.people.categories : p.people.versions;
  const seen = new Set<string>();
  for (const d of days)
    if (d.period)
      for (const [key, people] of Object.entries(bucketOf(d.period))) if (people > 0) seen.add(key);
  const keys =
    axis === 'category'
      ? [
          ...USAGE_CATEGORIES.filter((c) => seen.has(c)),
          ...[...seen].filter((k) => !(USAGE_CATEGORIES as readonly string[]).includes(k)).sort(),
        ]
      : [...seen].sort(compareVersionsDesc);
  const oldestFirst = keys.filter((k) => k !== 'unknown' && k !== 'other').reverse();
  const series = keys.map((key): Series => {
    const values = days.map((d) => (d.period ? (bucketOf(d.period)[key] ?? 0) : null));
    if (axis === 'version') return versionLine(key, oldestFirst, values);
    const slot = CATEGORY_SLOT[key];
    return slot && key !== 'other'
      ? { key, color: `var(--chart-series-${slot})`, values }
      : { key, color: 'var(--text-muted)', dash: '2 3', values };
  });
  return {
    times: days.map((d) => dayTime(d.start)),
    series,
    total: days.map((d) => (d.period ? d.period.people.all : null)),
  };
}

/**
 * The orders of magnitude of the headline: for each of day, week and month, the figure so far, the
 * LAST COMPLETE period's figure when the server has it, and the mean people per day over the last 7
 * and 30 complete days (days with a row only). A previous period is matched by its start date, so a
 * missing row is `undefined`, never a neighbour's figure.
 */
export function headline(view: UsageView): {
  now: Record<'day' | 'week' | 'month', number>;
  previous: Record<'day' | 'week' | 'month', number | undefined>;
  mean: Record<7 | 30, number | undefined>;
} {
  const shift = (start: string, days: number) =>
    new Date(Date.parse(`${start}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const find = (list: UsagePeriod[], start: string) => list.find((p) => p.start === start);
  const day = find(view.days, view.today);
  const week = view.weeks[view.weeks.length - 1];
  const month = view.months[view.months.length - 1];
  const prevMonth = month ? shift(month.start, -1).slice(0, 8) + '01' : undefined;
  const mean = (count: number) => {
    const figures = calendarDays(view.days, shift(view.today, -1), count)
      .map((d) => d.period?.people.all)
      .filter((n): n is number => n !== undefined);
    return figures.length === 0
      ? undefined
      : Math.round(figures.reduce((a, b) => a + b, 0) / figures.length);
  };
  return {
    now: { day: day?.people.all ?? 0, week: week?.people.all ?? 0, month: month?.people.all ?? 0 },
    previous: {
      day: find(view.days, shift(view.today, -1))?.people.all,
      week: week ? find(view.weeks, shift(week.start, -7))?.people.all : undefined,
      month: prevMonth ? find(view.months, prevMonth)?.people.all : undefined,
    },
    mean: { 7: mean(7), 30: mean(30) },
  };
}
