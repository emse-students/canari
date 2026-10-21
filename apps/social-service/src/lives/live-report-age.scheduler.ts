import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LIVE_REPORT_RESPONSE_WORKING_MS, LIVE_REPORT_WORKING_ZONE } from './live.constants';
import { readLiveReportAge, type LiveReportAgeReading } from './live-report-age';

const TAG = '[LIVE_REPORT_AGE]';
const HOUR_MS = 3_600_000;

/** Hours, one decimal: the unit a person reads an age of a day in. */
const hours = (ms: number) => (ms / HOUR_MS).toFixed(1);

/**
 * THE 24 H COMMITMENT, WATCHED (WP-L8b item e, docs/wiki/services/lives.md).
 *
 * The owner promised the stores that a live report is answered within 24 hours on working days
 * (2026-10-20). The queue had no age alarm, so the promise was a hope: a report nobody opened would
 * be found by hand, a day late. Every hour this reads the PENDING `live` and `live_chat` reports and
 * prints ONE line - `log` while every one is inside the commitment, `error` once one is past it,
 * naming the oldest one's working and wall-clock age and how many are late.
 *
 * NO USER DATA in either line: no report id, no account, no reason - counts and ages only, so the
 * line can be read, forwarded and kept anywhere. The queue (`/admin/moderation`) is where a
 * moderator goes from it.
 *
 * Purely a report: it changes nothing. It runs whatever `LIVE_ENABLED` says, like the sweep: a
 * report filed while the switch was on is still owed its answer after it is turned off. On an
 * estate with none it is one indexed empty query and a `pending=0` line - the line that proves the
 * alarm is alive, since an alarm that went silent would otherwise read as an empty queue.
 *
 * ONE CLOCK, THE DATABASE'S: the creation instants and `now()` come from the same statement.
 */
@Injectable()
export class LiveReportAgeScheduler {
  private readonly logger = new Logger(LiveReportAgeScheduler.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Hourly, at :53 - off the minutes the other hourly jobs of this service use (:23, :37, :41, :47). */
  @Cron('53 * * * *')
  async report(): Promise<void> {
    try {
      await this.reportOnce();
    } catch (e) {
      // An alarm that cannot read its queue is itself an alarm: the commitment is unwatched.
      this.logger.error(
        `${TAG} could not read the live report queue - the 24 h commitment is unwatched this hour: ${String(e)}`
      );
    }
  }

  /** One reading and its line, separated so a test can call it without a scheduler. */
  async reportOnce(): Promise<LiveReportAgeReading> {
    this.logger.debug(`${TAG} reading the pending live reports`);
    // `createdAt` is a `timestamp` without zone (TypeORM's CreateDateColumn), written by `now()` in
    // the session's zone; `::timestamptz` reads it back in that same zone, so the instant is exact
    // whatever the server's TimeZone is. The LEFT JOIN keeps one row - and `now()` - on an empty queue.
    const rows = (await this.ds.query(
      `SELECT now() AS now, r.at
         FROM (SELECT 1) one
         LEFT JOIN (SELECT "createdAt"::timestamptz AS at FROM content_reports
                     WHERE status = 'pending' AND "contentType" IN ('live', 'live_chat')) r ON true`
    )) as Array<{ now: Date | string; at: Date | string | null }>;
    const nowMs = new Date(rows[0].now).getTime();
    const createdAt = rows.filter((r) => r.at !== null).map((r) => new Date(r.at as Date | string));
    const reading = readLiveReportAge(
      createdAt,
      nowMs,
      LIVE_REPORT_RESPONSE_WORKING_MS,
      LIVE_REPORT_WORKING_ZONE
    );

    if (reading.pending === 0) {
      this.logger.log(`${TAG} pending=0`);
      return reading;
    }
    const summary =
      `pending=${reading.pending} overdue=${reading.overdue} ` +
      `oldest=${hours(reading.oldestWorkingMs ?? 0)}h working (${hours(reading.oldestWallMs ?? 0)}h wall)`;
    if (reading.overdue === 0) {
      this.logger.log(`${TAG} ${summary}, inside the ${hours(LIVE_REPORT_RESPONSE_WORKING_MS)}h`);
      return reading;
    }
    this.logger.error(
      `${TAG} ${summary}: ${reading.overdue} live report(s) past the ${hours(LIVE_REPORT_RESPONSE_WORKING_MS)}h ` +
        `working-day commitment to the stores - answer them in /admin/moderation`
    );
    return reading;
  }
}
