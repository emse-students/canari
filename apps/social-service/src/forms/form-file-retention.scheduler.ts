import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FormFile } from './entities/form-file.entity';
import { FormFilesService, FORM_FILE_UPLOAD_WINDOW_DAYS } from './form-files.service';
import type { FileBlobOutcome } from './form-files.service';
import { purgeExpiredFiles, type FileRetentionCandidate } from './file-retention-purge';

/** How many files one query takes. The run loops until nothing is due. */
const BATCH = 100;

const TAG = '[FORM_FILE_GC]';

/** What one run did, returned for the test and summarised in the log. */
export interface FormFilePurgeReport {
  /** Answers' files looked at, and how many are gone now (the answer kept). */
  answerFiles: { due: number; gone: number };
  /** Uploads never sent (or whose answer was deleted), and how many are gone with their row. */
  unsent: { due: number; gone: number };
  /** Files kept for the next run. */
  kept: number;
  blobs: Record<FileBlobOutcome, number>;
}

/**
 * Deletes the files of forms' FILE questions when their retention runs out - the ANSWER STAYS.
 *
 * Two predicates over `form_files` (migration 085), each a fact of the row:
 * - an ANSWER's file: sent (`submissionId` set), not purged, and `attachedAt` + the form's
 *   `fileRetentionDays` is past. The blob goes, then `purgedAt` is set: the manager reads
 *   "file deleted" where the file was, and the answer row is untouched.
 * - an UNSENT upload: `submissionId` null and older than the one-day upload window. Nothing cites it,
 *   so the blob goes and then the row. An answer deleted by a manager lands here too (its key sets
 *   `submissionId` back to NULL).
 *
 * The mechanism - blobs first, the reference cleared only for a blob that is gone, failures excluded
 * from the run's own next query - is `purgeExpiredFiles`, which takes its starting date as a
 * parameter so a booking (start = the end of its slot) reuses it unchanged.
 *
 * THE ALLOWLIST: only rows of `form_files` are ever candidates, and the media service deletes only a
 * `form-file` object of the named uploader. Idempotent: a second run finds nothing, and a run after a
 * crash meets `absent` blobs, which clear their rows.
 */
@Injectable()
export class FormFileRetentionScheduler {
  private readonly logger = new Logger(FormFileRetentionScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(FormFile) private readonly fileRepo: Repository<FormFile>,
    private readonly files: FormFilesService
  ) {}

  /** Hourly, at :37 - off the minutes the reel worker (:23) and the other jobs use. */
  @Cron('37 * * * *')
  async purgeExpiredFormFiles(): Promise<void> {
    if (this.running) {
      this.logger.warn(`${TAG} the previous run is still going - this tick is skipped`);
      return;
    }
    this.running = true;
    try {
      await this.purgeOnce();
    } catch (e) {
      this.logger.warn(`${TAG} run failed before it could process the due files`, e);
    } finally {
      this.running = false;
    }
  }

  /**
   * The whole run, separated so a test can call it without a scheduler.
   *
   * ONE CLOCK, THE DATABASE'S. The selection and `purgeExpiredFiles`' re-check of each candidate are
   * the same predicate, so they read the same instant: `now` is taken from PostgreSQL once and handed
   * to both - a selection by `NOW()` re-checked against this box's clock would, on any skew, select a
   * file the re-check calls early and log an error for it every hour. The interval is counted in
   * HOURS (24 x days), the arithmetic the re-check uses, never in calendar days, which a session time
   * zone with daylight saving makes 23 or 25 hours long.
   *
   * @param at The instant to judge at; omitted, the database's `NOW()`.
   */
  async purgeOnce(at?: Date): Promise<FormFilePurgeReport> {
    const now = at ?? (await this.databaseNow());
    const report: FormFilePurgeReport = {
      answerFiles: { due: 0, gone: 0 },
      unsent: { due: 0, gone: 0 },
      kept: 0,
      blobs: { deleted: 0, absent: 0, refused: 0, failed: 0 },
    };
    const deleteBlobs = (items: Array<{ mediaId: string; ownerId: string }>) =>
      this.files.purgeBlobs(items);

    await this.pass(
      report.answerFiles,
      report,
      now,
      (excluded) =>
        this.fileRepo.query(
          `SELECT ff.id, ff."uploaderId", ff."attachedAt" AS start, f."fileRetentionDays" AS days
             FROM form_files ff JOIN forms f ON f.id = ff."formId"
            WHERE ff."purgedAt" IS NULL AND ff."submissionId" IS NOT NULL
              AND ff."attachedAt" + make_interval(hours => 24 * f."fileRetentionDays") <= $3::timestamptz
              AND ff.id <> ALL($1::uuid[])
            ORDER BY ff."attachedAt" ASC
            LIMIT $2`,
          [excluded, BATCH, now]
        ),
      { deleteBlobs, markGone: (id) => this.markAnswerFileGone(id) }
    );

    await this.pass(
      report.unsent,
      report,
      now,
      (excluded) =>
        this.fileRepo.query(
          `SELECT id, "uploaderId", "createdAt" AS start, $3::int AS days
             FROM form_files
            WHERE "purgedAt" IS NULL AND "submissionId" IS NULL
              AND "createdAt" <= $4::timestamptz - make_interval(hours => 24 * $3::int)
              AND id <> ALL($1::uuid[])
            ORDER BY "createdAt" ASC
            LIMIT $2`,
          [excluded, BATCH, FORM_FILE_UPLOAD_WINDOW_DAYS, now]
        ),
      { deleteBlobs, markGone: (id) => this.deleteUnsentRow(id) }
    );

    // A purged answer whose answer was later deleted: no blob left, nothing cites the row.
    const swept = (await this.fileRepo.query(
      `WITH gone AS (
         DELETE FROM form_files WHERE "submissionId" IS NULL AND "purgedAt" IS NOT NULL RETURNING id)
       SELECT id FROM gone`
    )) as Array<{ id: string }>;

    if (report.answerFiles.due + report.unsent.due + swept.length > 0) {
      const b = report.blobs;
      this.logger.log(
        `${TAG} answers due=${report.answerFiles.due} gone=${report.answerFiles.gone} ` +
          `unsent due=${report.unsent.due} gone=${report.unsent.gone} kept=${report.kept} ` +
          `rows-swept=${swept.length} blobs(deleted=${b.deleted} absent=${b.absent} refused=${b.refused} failed=${b.failed})`
      );
    }
    return report;
  }

  /** One predicate, looped until it selects nothing; what is kept is excluded from the next query. */
  private async pass(
    counts: { due: number; gone: number },
    report: FormFilePurgeReport,
    now: Date,
    select: (excluded: string[]) => Promise<DueFileRow[]>,
    deps: Parameters<typeof purgeExpiredFiles>[2]
  ): Promise<void> {
    const excluded: string[] = [];
    for (;;) {
      const rows = await select(excluded);
      if (rows.length === 0) return;
      const candidates: FileRetentionCandidate[] = rows.map((row) => ({
        fileId: row.id,
        ownerId: row.uploaderId,
        start: new Date(row.start),
        retentionDays: Number(row.days),
      }));
      counts.due += candidates.length;
      const result = await purgeExpiredFiles(candidates, now, deps, this.logger, TAG);
      counts.gone += result.gone.length;
      report.kept += result.kept.length;
      for (const [outcome, n] of Object.entries(result.blobs)) {
        report.blobs[outcome as FileBlobOutcome] += n;
      }
      excluded.push(...result.kept);
      // A row neither gone nor kept would be selected again for ever; every candidate is one or
      // the other, and this is the line that says so if that ever stops being true.
      const settled = new Set([...result.gone, ...result.kept]);
      const unsettled = candidates.filter((c) => !settled.has(c.fileId));
      if (unsettled.length > 0) {
        this.logger.error(`${TAG} ${unsettled.length} file(s) neither gone nor kept - stopping`);
        return;
      }
    }
  }

  /** PostgreSQL's clock - the one every predicate over `form_files` is written against. */
  private async databaseNow(): Promise<Date> {
    const [{ now }] = (await this.fileRepo.query(`SELECT NOW() AS now`)) as Array<{
      now: Date | string;
    }>;
    return new Date(now);
  }

  /** The answer's file is gone: the row says so, and the answer is not touched. */
  private async markAnswerFileGone(id: string): Promise<void> {
    await this.fileRepo.query(
      `WITH marked AS (
         UPDATE form_files SET "purgedAt" = NOW()
          WHERE id = $1 AND "purgedAt" IS NULL AND "submissionId" IS NOT NULL RETURNING id)
       SELECT id FROM marked`,
      [id]
    );
  }

  /** An unsent upload's blob is gone: nothing cites the row, so it goes too. */
  private async deleteUnsentRow(id: string): Promise<void> {
    await this.fileRepo.query(
      `WITH gone AS (
         DELETE FROM form_files
          WHERE id = $1 AND "submissionId" IS NULL AND "purgedAt" IS NULL RETURNING id)
       SELECT id FROM gone`,
      [id]
    );
  }
}

/** The columns a due file is read with. */
interface DueFileRow {
  id: string;
  uploaderId: string;
  start: Date | string;
  days: number | string;
}
