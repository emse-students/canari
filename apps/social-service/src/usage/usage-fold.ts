import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RedisService } from '../common/redis';
import { addDays, daysFrom, monthStart, nextMonthStart, parisSlot, weekStart } from './paris-time';
import {
  activityKey,
  peopleCategoryKey,
  peopleKey,
  isFoldableVersion,
  peopleVersionKey,
  peopleVersionsKey,
  USAGE_ACTIVITY_METRICS,
  USAGE_CATEGORIES,
  USAGE_FOLD_DAYS,
} from './usage-contract';

const TAG = '[USAGE_FOLD]';

/** A period of the dashboard: a Paris day, an ISO week or a calendar month. */
export type UsagePeriod = 'day' | 'week' | 'month';

/** One durable figure (`usage_figures`, migration 182). */
export interface UsageFigure {
  period: UsagePeriod;
  /** The period's first Paris day, `YYYY-MM-DD`. */
  start: string;
  /** `people`, or an activity metric. */
  metric: string;
  /** `all`, `cat:<category>` or `ver:<version>`. */
  dimension: string;
  value: number;
}

/** What the fold reads Redis through - `RedisService`'s pipelined reads, or a test's double. */
export type UsageRedisReader = Pick<RedisService, 'pfcountEach' | 'smembersEach' | 'hgetallEach'>;

/** A period and the days of it the fold may read (never a day after today). */
interface Span {
  period: UsagePeriod;
  start: string;
  days: string[];
}

/**
 * The periods whose keys all still live on `today`: each of the last {@link USAGE_FOLD_DAYS} days,
 * and each week and month STARTING among them (a period that started earlier was folded whole while
 * its first day was still inside the window, and keeps that value).
 */
export function foldSpans(today: string): Span[] {
  const days = daysFrom(addDays(today, -(USAGE_FOLD_DAYS - 1)), today);
  const first = days[0];
  const clip = (from: string, toExclusive: string) =>
    daysFrom(from, addDays(toExclusive, -1)).filter((d) => d <= today);
  const spans: Span[] = days.map((d) => ({ period: 'day', start: d, days: [d] }));
  for (const w of new Set(days.map(weekStart))) {
    if (w >= first) spans.push({ period: 'week', start: w, days: clip(w, addDays(w, 7)) });
  }
  for (const mo of new Set(days.map(monthStart))) {
    if (mo >= first) spans.push({ period: 'month', start: mo, days: clip(mo, nextMonthStart(mo)) });
  }
  return spans;
}

/**
 * Every figure of every period {@link foldSpans} names, read from Redis in three round trips. A
 * week or a month is the UNION of its days' HyperLogLogs - a person on Monday and Friday is one
 * person in the week. Activity is folded per day only (a week's or a month's is the sum of its days,
 * done at read). A category or a version with nobody is no row; `people/all` and the six activity
 * metrics of a day are always written, so a folded day with nobody says 0, not nothing. A version
 * that is not a release ({@link isFoldableVersion}) is never a row: it is handed to `onRefused`, and
 * its people stay in `all` and their category.
 */
export async function readFigures(
  reader: UsageRedisReader,
  today: string,
  onRefused: (version: string) => void = () => undefined
): Promise<UsageFigure[]> {
  const spans = foldSpans(today);
  const days = spans.filter((s) => s.period === 'day').map((s) => s.start);
  const versionSets = await reader.smembersEach(days.map(peopleVersionsKey));
  const versionsOf = new Map(days.map((d, i) => [d, versionSets[i] ?? []]));
  const activity = await reader.hgetallEach(days.map(activityKey));

  // Every PFCOUNT of every span, in one pipeline, each tagged with the figure it answers.
  const asked: { span: Span; dimension: string; keys: string[] }[] = [];
  for (const span of spans) {
    asked.push({ span, dimension: 'all', keys: span.days.map(peopleKey) });
    for (const c of USAGE_CATEGORIES) {
      asked.push({
        span,
        dimension: `cat:${c}`,
        keys: span.days.map((d) => peopleCategoryKey(d, c)),
      });
    }
    const versions = new Set(span.days.flatMap((d) => versionsOf.get(d) ?? []));
    for (const v of [...versions].sort()) {
      if (!isFoldableVersion(v)) {
        if (span.period === 'day') onRefused(v);
        continue;
      }
      asked.push({
        span,
        dimension: `ver:${v}`,
        keys: span.days.map((d) => peopleVersionKey(d, v)),
      });
    }
  }
  const counts = await reader.pfcountEach(asked.map((a) => a.keys));

  const figures: UsageFigure[] = [];
  asked.forEach(({ span, dimension }, i) => {
    const value = Number(counts[i] ?? 0);
    if (dimension !== 'all' && value === 0) return;
    figures.push({ period: span.period, start: span.start, metric: 'people', dimension, value });
  });
  days.forEach((day, i) => {
    const hash = activity[i] ?? {};
    for (const metric of USAGE_ACTIVITY_METRICS) {
      const value = Number.parseInt(hash[metric] ?? '0', 10);
      figures.push({
        period: 'day',
        start: day,
        metric,
        dimension: 'all',
        value: Number.isFinite(value) ? value : 0,
      });
    }
  });
  return figures;
}

/**
 * Upserts `figures` in ONE statement, in primary-key order (two replicas folding at once wait on
 * each other in the same order, so they cannot deadlock), keeping the LARGER value: every input
 * only grows, so the newest reading is the largest, and a late increment is folded by the next run
 * rather than by a "the day is closed" decision a clock would have to make.
 */
export async function writeFigures(
  ds: Pick<DataSource, 'query'>,
  figures: UsageFigure[]
): Promise<number> {
  if (figures.length === 0) return 0;
  const rows = [...figures].sort((a, b) =>
    `${a.period}|${a.start}|${a.metric}|${a.dimension}` <
    `${b.period}|${b.start}|${b.metric}|${b.dimension}`
      ? -1
      : 1
  );
  await ds.query(
    `INSERT INTO usage_figures (period, start, metric, dimension, value)
     SELECT period, start, metric, dimension, value
       FROM unnest($1::varchar[], $2::date[], $3::varchar[], $4::varchar[], $5::bigint[])
         WITH ORDINALITY AS r(period, start, metric, dimension, value, n)
      ORDER BY n
     ON CONFLICT (period, start, metric, dimension)
     DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
      WHERE usage_figures.value < EXCLUDED.value`,
    [
      rows.map((r) => r.period),
      rows.map((r) => r.start),
      rows.map((r) => r.metric),
      rows.map((r) => r.dimension),
      rows.map((r) => r.value),
    ]
  );
  return rows.length;
}

/**
 * THE FOLD (docs/wiki/usage-dashboard.md, "The fold"): the live counters in Redis, written by the
 * gateway and the services, become the durable figures in PostgreSQL - kept with no limit (owner,
 * 2026-11-16) and in the nightly backup, which Redis is not. Every replica runs it every hour and
 * before every read; it is idempotent, so how many run changes nothing.
 */
@Injectable()
export class UsageFold {
  private readonly logger = new Logger(UsageFold.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly redis: RedisService
  ) {}

  /** Hourly, at :29 - off the minutes this service's other hourly jobs use. */
  @Cron('29 * * * *')
  async hourly(): Promise<void> {
    try {
      await this.foldOnce(new Date());
    } catch (e) {
      // The keys live 40 days and the next hour folds again, but a fold that keeps failing loses the
      // figures of every period whose keys expire meanwhile: an error, not a warn.
      this.logger.error(`${TAG} the hourly fold failed - nothing was written: ${String(e)}`);
    }
  }

  /** One fold at `now` (the caller's clock). Throws when Redis or the database cannot be read. */
  async foldOnce(now: Date): Promise<{ today: string; written: number }> {
    const { day: today } = parisSlot(now);
    this.logger.debug(`${TAG} folding the ${USAGE_FOLD_DAYS} days up to ${today}`);
    let refused = 0;
    const figures = await readFigures(this.redis, today, () => {
      refused += 1;
    });
    if (refused > 0) {
      // The gateway counts a non-release as `other`, so a set holding one means a writer that skipped
      // that rule. Its text is not logged: it is exactly what must not be kept.
      this.logger.warn(
        `${TAG} ${refused} day-version(s) in Redis are not releases - not folded; a writer bypassed usage::release_version`
      );
    }
    const written = await writeFigures(this.ds, figures);
    this.logger.log(`${TAG} folded ${written} figure(s) up to ${today}`);
    return { today, written };
  }
}
