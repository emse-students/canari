import type { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

/**
 * THE USAGE DASHBOARD'S DAILY ACTIVITY TOTALS, for the two this service is where the fact is known:
 * a message sent and a call started (docs/wiki/usage-dashboard.md, owner 2026-11-16).
 *
 * WHOLE PLATFORM, PER PARIS DAY, NOTHING ELSE: one counter per (day, metric) - never per hour, per
 * platform, per conversation or per author (charter principle 1: a message is counted as volume,
 * from a frame the server already accepted, never read). The key and the metric names are pinned by
 * `libs/contracts/usage-dashboard.json`, read by the social-service fold that writes the durable
 * figures, and this file's twin there (`social-service/src/usage/usage-activity.ts`) counts the other
 * four metrics into the same hash.
 */

/** The metrics this service counts. */
export type UsageActivityMetric = 'messages' | 'calls';

/** A day's counters live 40 days (the contract's `dayKeyTtlSecs`): the fold reads 35. */
export const USAGE_DAY_KEY_TTL_SECS = 40 * 24 * 60 * 60;

const PARIS_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Paris calendar day of an instant, `YYYY-MM-DD` (Intl's zone data, never a fixed offset). */
export function parisDay(at: Date): string {
  const parts = Object.fromEntries(PARIS_DAY.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The hash holding one Paris day's activity counters. */
export function usageActivityKey(day: string): string {
  return `usage:activity:${day}`;
}

/**
 * Adds one to `metric` for the Paris day of `at`, and gives the day's hash its expiry in the same
 * transaction, so the key never exists without one. NEVER THROWS: a lost count costs the dashboard
 * one unit, never the send or the call that was counted - it is logged at warn, naming what was lost.
 * The caller does not wait for it.
 */
export async function countUsageActivity(
  redis: Pick<Redis, 'multi'>,
  metric: UsageActivityMetric,
  logger: Pick<Logger, 'debug' | 'warn'>,
  at: Date = new Date()
): Promise<void> {
  const day = parisDay(at);
  const key = usageActivityKey(day);
  try {
    const results = await redis
      .multi()
      .hincrby(key, metric, 1)
      .expire(key, USAGE_DAY_KEY_TTL_SECS)
      .exec();
    const failed = results?.find(([err]) => err)?.[0];
    if (!results || failed) throw failed ?? new Error('the transaction was discarded');
    logger.debug(`[USAGE] ${metric} +1 on ${day}`);
  } catch (e) {
    logger.warn(
      `[USAGE] ${metric} NOT counted on ${day} - the dashboard's total is one short: ${String(e)}`
    );
  }
}
