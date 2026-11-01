import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * How far this process's clock and the database's `now()::timestamp` may disagree, read back
 * through the driver, before the boot check accuses. A minute is far above any honest skew between
 * two clocks on one host (milliseconds) and far below a time-zone offset (an hour at least).
 */
export const CLOCK_AGREEMENT_BOUND_MS = 60_000;

/**
 * Logs at ERROR, once at boot, when this process and the database do not agree on what time it is
 * as a `timestamp WITHOUT time zone` reads it - and never throws: an estate that disagrees still
 * serves, but it says so where an operator reads it.
 *
 * **WHY.** Every instant column of this service is `timestamp WITHOUT time zone`. A JavaScript `Date`
 * is written as this process's local wall time, `now()` (every `CreateDateColumn`) as the database
 * session's, and both are read back as this process's. Two code paths compare the two kinds:
 * `ensureGroupMember` (an interval's `joinedAt` against the earliest device row) and
 * `withheldWindows` (the arrival is the earlier of the two). When the zones differ, one side is off
 * by the full offset and a newcomer is served that much of the group's past (measured: one hour
 * under `TZ=Europe/Paris` against a UTC database, review of #2800). The invariant - both in UTC - was
 * measured on production on 2026-10-14 and stated in a comment; this is what keeps it a fact.
 *
 * `now()::timestamp` is exactly what a `CreateDateColumn` default stores, read back as every such
 * column is, so the difference measured here is the difference those comparisons carry.
 */
export async function checkDatabaseClockAgreement(
  manager: Pick<EntityManager, 'query'>,
  logger: Pick<Logger, 'log' | 'error'>
): Promise<'agree' | 'disagree' | 'unreadable'> {
  try {
    const before = Date.now();
    const rows: Array<{ db: Date | string | null }> = await manager.query(
      'SELECT now()::timestamp AS db'
    );
    const after = Date.now();
    const raw = rows[0]?.db;
    const db = raw === null || raw === undefined ? Number.NaN : new Date(raw).getTime();
    if (!Number.isFinite(db)) {
      logger.error(
        `[CLOCK] the database answered no readable now()::timestamp (${String(raw)}) - ` +
          `whether this process and Postgres agree on the time zone is NOT known`
      );
      return 'unreadable';
    }
    const local = (before + after) / 2;
    const skew = db - local;
    const zone = process.env.TZ ?? '(unset)';
    if (Math.abs(skew) > CLOCK_AGREEMENT_BOUND_MS) {
      logger.error(
        `[CLOCK] this process and Postgres disagree by ${Math.round(skew / 1000)} s ` +
          `(TZ=${zone}, offset ${-new Date().getTimezoneOffset()} min) - every timestamp WITHOUT ` +
          `time zone written by now() reads that far off here, so a newcomer's arrival ` +
          `(withheldWindows, ensureGroupMember, dateArrivalAtAdmission) is wrong by as much. ` +
          `Run both in UTC.`
      );
      return 'disagree';
    }
    logger.log(`[CLOCK] this process and Postgres agree within ${Math.abs(Math.round(skew))} ms`);
    return 'agree';
  } catch (e) {
    logger.error(
      `[CLOCK] the clock agreement check could not run - whether this process and Postgres ` +
        `agree on the time zone is NOT known: ${String(e).slice(0, 160)}`
    );
    return 'unreadable';
  }
}
