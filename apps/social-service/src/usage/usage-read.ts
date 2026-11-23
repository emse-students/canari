import type { DataSource } from 'typeorm';
import { addDays, parisSlot, weekdayIndex } from './paris-time';
import {
  peopleHourKey,
  USAGE_ACTIVITY_METRICS,
  USAGE_HOUR_MAP_DAYS,
  type UsageActivityMetric,
} from './usage-contract';
import type { UsageRedisReader } from './usage-fold';

/** Distinct people in a period, overall and broken down. No identifier of any kind. */
export interface PeopleFigures {
  all: number;
  categories: Record<string, number>;
  versions: Record<string, number>;
}

/** One period of the answer. `activity` is on days only (owner: per day, never finer). */
export interface UsagePeriodView {
  start: string;
  people: PeopleFigures;
  activity?: Record<UsageActivityMetric, number>;
}

/** `GET /api/admin/usage` (docs/wiki/usage-dashboard.md, "The read"). */
export interface UsageView {
  timeZone: 'Europe/Paris';
  today: string;
  days: UsagePeriodView[];
  weeks: UsagePeriodView[];
  months: UsagePeriodView[];
  /** `cells[weekday][hour]`, weekday 0 = Monday: mean distinct people in that Paris hour. */
  hours: { from: string; to: string; cells: number[][] };
}

/** How many days of daily figures the answer carries: a school year and its neighbour. */
export const USAGE_DAYS_ANSWERED = 366;

interface FigureRow {
  period: 'day' | 'week' | 'month';
  /** `YYYY-MM-DD`: the read names it with `to_char`, so no driver turns a date into an instant. */
  start: string;
  metric: string;
  dimension: string;
  value: string | number;
}

const asDay = (v: string) => v.slice(0, 10);

/**
 * Groups the stored rows into periods, oldest first. A period appears only when it has a
 * `people/all` row - the mark that it was folded; nothing is invented for a period never folded.
 */
export function shapePeriods(rows: FigureRow[]): Pick<UsageView, 'days' | 'weeks' | 'months'> {
  const by = {
    day: new Map<string, UsagePeriodView>(),
    week: new Map(),
    month: new Map(),
  } as Record<FigureRow['period'], Map<string, UsagePeriodView>>;
  const sorted = [...rows].sort((a, b) => (asDay(a.start) < asDay(b.start) ? -1 : 1));
  for (const row of sorted) {
    if (row.metric !== 'people' || row.dimension !== 'all') continue;
    const start = asDay(row.start);
    by[row.period].set(start, {
      start,
      people: { all: Number(row.value), categories: {}, versions: {} },
      ...(row.period === 'day'
        ? {
            activity: Object.fromEntries(USAGE_ACTIVITY_METRICS.map((m) => [m, 0])) as Record<
              UsageActivityMetric,
              number
            >,
          }
        : {}),
    });
  }
  for (const row of sorted) {
    const view = by[row.period].get(asDay(row.start));
    if (!view) continue;
    const value = Number(row.value);
    if (row.metric === 'people') {
      if (row.dimension.startsWith('cat:')) view.people.categories[row.dimension.slice(4)] = value;
      else if (row.dimension.startsWith('ver:'))
        view.people.versions[row.dimension.slice(4)] = value;
    } else if (
      view.activity &&
      (USAGE_ACTIVITY_METRICS as readonly string[]).includes(row.metric)
    ) {
      view.activity[row.metric as UsageActivityMetric] = value;
    }
  }
  return {
    days: [...by.day.values()],
    weeks: [...by.week.values()],
    months: [...by.month.values()],
  };
}

/**
 * Every Paris (day, hour) of the {@link USAGE_HOUR_MAP_DAYS} days before `today`, each ONCE: built by
 * walking UTC hours and naming each one's Paris slot, so the autumn hour that happens twice is one
 * slot and the spring hour that does not exist is no slot at all.
 */
export function hourSlots(today: string): {
  from: string;
  to: string;
  slots: { day: string; hour: number }[];
} {
  const from = addDays(today, -USAGE_HOUR_MAP_DAYS);
  const to = addDays(today, -1);
  const seen = new Set<string>();
  const slots: { day: string; hour: number }[] = [];
  const startMs = Date.parse(`${from}T00:00:00Z`) - 3 * 3_600_000;
  const endMs = Date.parse(`${today}T00:00:00Z`) + 3 * 3_600_000;
  for (let ms = startMs; ms <= endMs; ms += 3_600_000) {
    const slot = parisSlot(new Date(ms));
    const name = `${slot.day}T${slot.hour}`;
    if (slot.day < from || slot.day > to || seen.has(name)) continue;
    seen.add(name);
    slots.push(slot);
  }
  return { from, to, slots };
}

/** The week-by-hour map: the mean of each (weekday, hour)'s distinct people over the slots that exist. */
export async function readHourMap(
  reader: Pick<UsageRedisReader, 'pfcountEach'>,
  today: string
): Promise<UsageView['hours']> {
  const { from, to, slots } = hourSlots(today);
  const counts = await reader.pfcountEach(slots.map((s) => [peopleHourKey(s.day, s.hour)]));
  const grid = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const sum = grid();
  const n = grid();
  slots.forEach((s, i) => {
    const d = weekdayIndex(s.day);
    sum[d][s.hour] += Number(counts[i] ?? 0);
    n[d][s.hour] += 1;
  });
  const cells = sum.map((row, d) =>
    row.map((total, h) => (n[d][h] === 0 ? 0 : Math.round((total / n[d][h]) * 10) / 10))
  );
  return { from, to, cells };
}

/** The whole answer at `now`: the stored figures (the caller folded first) and the live hour map. */
export async function readUsage(
  ds: Pick<DataSource, 'query'>,
  reader: Pick<UsageRedisReader, 'pfcountEach'>,
  now: Date
): Promise<UsageView> {
  const { day: today } = parisSlot(now);
  const firstDay = addDays(today, -(USAGE_DAYS_ANSWERED - 1));
  const rows = (await ds.query(
    `SELECT period, to_char(start, 'YYYY-MM-DD') AS start, metric, dimension, value
       FROM usage_figures
      WHERE period <> 'day' OR start >= $1::date`,
    [firstDay]
  )) as FigureRow[];
  return {
    timeZone: 'Europe/Paris',
    today,
    ...shapePeriods(rows),
    hours: await readHourMap(reader, today),
  };
}
