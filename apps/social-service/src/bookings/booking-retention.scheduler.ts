import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FormFilesService, FORM_FILE_UPLOAD_WINDOW_DAYS } from '../forms/form-files.service';
import type { FileBlobOutcome } from '../forms/form-files.service';
import { runFileRetentionPass } from '../forms/file-retention-purge';
import { BookingFile } from './entities/booking-file.entity';

/** How many rows one query takes. Each pass loops until nothing is due. */
const BATCH = 100;

const TAG = '[BOOKING_RETENTION]';

/**
 * THE PLATFORM MAXIMUM AGE OF A BOOKING (D19, D23): one year after its slot, as a constant nobody
 * adjusts. Everything older goes - the history row, its participants, a block - so the frozen
 * history (D15) is bounded, and with it the names it keeps of deleted accounts.
 */
export const BOOKING_MAX_AGE = '1 year';

/** What one run did, returned for the test and summarised in the log. */
export interface BookingRetentionReport {
  /** Bookings' files looked at, and how many are gone now (the booking kept). */
  files: { due: number; gone: number };
  /** Uploads never sent, or whose booking is gone, and how many went with their row. */
  unsent: { due: number; gone: number };
  /** Files kept for the next run (the media service did not finish them). */
  kept: number;
  blobs: Record<FileBlobOutcome, number>;
  /** Bookings whose answers were purged (D18). */
  answersPurged: number;
  /** Bookings and blocks deleted past the maximum age (D19). */
  bookingsDeleted: number;
  blocksDeleted: number;
}

/**
 * WHAT A BOOKING KEEPS, AND FOR HOW LONG (D8, D18, D19, D23, D41) - one hourly run, four passes,
 * each a predicate over durable columns, so a run after a crash finds exactly what the crashed run
 * left and a second run finds nothing (THE STATE IS THE ROW):
 *
 * 1. A booking's FILES, `retentionDays` after the END OF ITS SLOT (D41's second starting point):
 *    the blob first, then `purgedAt` - the organiser reads "file deleted". The forms' mechanism,
 *    `purgeExpiredFiles`, with the slot's end as its start.
 * 2. UNSENT uploads, older than the one-day upload window - and the files of a booking that is gone
 *    (its space deleted, D27, or past the maximum age), whose foreign key set them back to unsent.
 *    Nothing cites them: the blob goes, then the row.
 * 3. The ANSWERS, the same `retentionDays` after the slot's end (D18: "purged with the file, one
 *    rule to explain"): `answers` NULL, `answersPurgedAt` set. The booking row stays (D15).
 * 4. THE MAXIMUM AGE (D19): every booking and every block that ENDED more than {@link BOOKING_MAX_AGE}
 *    ago is deleted - its participants with it (their foreign key cascades), its files back to pass 2.
 *
 * ONE CLOCK, THE DATABASE'S, read once per run and handed to every predicate and to the re-check
 * `purgeExpiredFiles` makes before it deletes (the forms' scheduler's rule). Retention is counted in
 * HOURS (24 x days), as the re-check counts it.
 *
 * THE ALLOWLIST: only rows of `booking_files` are file candidates, and the media service deletes only
 * a `form-file` object of the named uploader.
 */
@Injectable()
export class BookingRetentionScheduler {
  private readonly logger = new Logger(BookingRetentionScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(BookingFile) private readonly files: Repository<BookingFile>,
    private readonly formFiles: FormFilesService
  ) {}

  /** Hourly, at :41 - off the minutes the reel worker (:23) and the forms' file purge (:37) use. */
  @Cron('41 * * * *')
  async purgeExpired(): Promise<void> {
    if (this.running) {
      this.logger.warn(`${TAG} the previous run is still going - this tick is skipped`);
      return;
    }
    this.running = true;
    try {
      await this.purgeOnce();
    } catch (e) {
      this.logger.warn(`${TAG} run failed before it could finish - retried next hour`, e);
    } finally {
      this.running = false;
    }
  }

  /**
   * The whole run, separated so a test can call it without a scheduler.
   *
   * @param at The instant to judge at; omitted, the database's `NOW()`.
   */
  async purgeOnce(at?: Date): Promise<BookingRetentionReport> {
    const now = at ?? (await this.databaseNow());
    const report: BookingRetentionReport = {
      files: { due: 0, gone: 0 },
      unsent: { due: 0, gone: 0 },
      kept: 0,
      blobs: { deleted: 0, absent: 0, refused: 0, failed: 0 },
      answersPurged: 0,
      bookingsDeleted: 0,
      blocksDeleted: 0,
    };
    const deleteBlobs = (items: Array<{ mediaId: string; ownerId: string }>) =>
      this.formFiles.purgeBlobs(items);
    const q = (sql: string, params: unknown[]) => this.files.query(sql, params);

    // 1. A booking's files, N days after its slot's end.
    await runFileRetentionPass(
      report.files,
      report,
      now,
      (excluded) =>
        q(
          `SELECT f.id, f."uploaderId", b."endsAt" AS start, s."retentionDays" AS days
             FROM booking_files f
             JOIN bookings b ON b.id = f."bookingId"
             JOIN booking_resources r ON r.id = b."resourceId"
             JOIN booking_spaces s ON s.id = r."spaceId"
            WHERE f."purgedAt" IS NULL
              AND b."endsAt" + make_interval(hours => 24 * s."retentionDays") <= $3::timestamptz
              AND f.id <> ALL($1::uuid[])
            ORDER BY b."endsAt" ASC
            LIMIT $2`,
          [excluded, BATCH, now]
        ),
      { deleteBlobs, markGone: (id) => this.markFileGone(id) },
      this.logger,
      TAG
    );

    // 2. Uploads nothing cites, past the upload window.
    await runFileRetentionPass(
      report.unsent,
      report,
      now,
      (excluded) =>
        q(
          `SELECT id, "uploaderId", "createdAt" AS start, $3::int AS days
             FROM booking_files
            WHERE "purgedAt" IS NULL AND "bookingId" IS NULL
              AND "createdAt" <= $4::timestamptz - make_interval(hours => 24 * $3::int)
              AND id <> ALL($1::uuid[])
            ORDER BY "createdAt" ASC
            LIMIT $2`,
          [excluded, BATCH, FORM_FILE_UPLOAD_WINDOW_DAYS, now]
        ),
      { deleteBlobs, markGone: (id) => this.deleteUnsentRow(id) },
      this.logger,
      TAG
    );

    // 3. The answers, the same N days after the slot's end (D18).
    const answers = (await q(
      `WITH purged AS (
         UPDATE bookings b SET answers = NULL, "answersPurgedAt" = $1::timestamptz
           FROM booking_resources r, booking_spaces s
          WHERE r.id = b."resourceId" AND s.id = r."spaceId"
            AND b.answers IS NOT NULL
            AND b."endsAt" + make_interval(hours => 24 * s."retentionDays") <= $1::timestamptz
          RETURNING b.id)
       SELECT count(*)::int AS n FROM purged`,
      [now]
    )) as Array<{ n: number }>;
    report.answersPurged = answers[0]?.n ?? 0;

    // 4. The maximum age (D19), in batches so one run never holds a long lock.
    report.bookingsDeleted = await this.deleteOlderThanMaxAge('bookings', now);
    report.blocksDeleted = await this.deleteOlderThanMaxAge('booking_blocks', now);

    // A purged file whose booking is gone: no blob left, nothing cites the row.
    const swept = (await q(
      `WITH gone AS (
         DELETE FROM booking_files WHERE "bookingId" IS NULL AND "purgedAt" IS NOT NULL RETURNING id)
       SELECT count(*)::int AS n FROM gone`,
      []
    )) as Array<{ n: number }>;

    const did =
      report.files.due +
      report.unsent.due +
      report.answersPurged +
      report.bookingsDeleted +
      report.blocksDeleted +
      (swept[0]?.n ?? 0);
    if (did > 0) {
      const b = report.blobs;
      this.logger.log(
        `${TAG} files due=${report.files.due} gone=${report.files.gone} ` +
          `unsent due=${report.unsent.due} gone=${report.unsent.gone} kept=${report.kept} ` +
          `answers-purged=${report.answersPurged} bookings-deleted=${report.bookingsDeleted} ` +
          `blocks-deleted=${report.blocksDeleted} rows-swept=${swept[0]?.n ?? 0} ` +
          `blobs(deleted=${b.deleted} absent=${b.absent} refused=${b.refused} failed=${b.failed})`
      );
    }
    return report;
  }

  /** Deletes, batch by batch, the rows of `table` that ENDED more than the maximum age before `now`. */
  private async deleteOlderThanMaxAge(
    table: 'bookings' | 'booking_blocks',
    now: Date
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const [{ n }] = (await this.files.query(
        `WITH gone AS (
           DELETE FROM ${table} WHERE id IN (
             SELECT id FROM ${table}
              WHERE "endsAt" <= $1::timestamptz - $2::interval
              LIMIT $3)
           RETURNING id)
         SELECT count(*)::int AS n FROM gone`,
        [now, BOOKING_MAX_AGE, BATCH]
      )) as Array<{ n: number }>;
      total += n;
      if (n < BATCH) return total;
    }
  }

  /** PostgreSQL's clock - the one every predicate here is written against. */
  private async databaseNow(): Promise<Date> {
    const [{ now }] = (await this.files.query(`SELECT NOW() AS now`)) as Array<{
      now: Date | string;
    }>;
    return new Date(now);
  }

  /** A booking's file is gone: the row says so. */
  private async markFileGone(id: string): Promise<void> {
    await this.files.query(
      `UPDATE booking_files SET "purgedAt" = NOW() WHERE id = $1 AND "purgedAt" IS NULL`,
      [id]
    );
  }

  /** An unsent upload's blob is gone: nothing cites the row, so it goes too. */
  private async deleteUnsentRow(id: string): Promise<void> {
    await this.files.query(
      `DELETE FROM booking_files WHERE id = $1 AND "bookingId" IS NULL AND "purgedAt" IS NULL`,
      [id]
    );
  }
}
