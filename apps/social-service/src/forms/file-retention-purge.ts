import type { Logger } from '@nestjs/common';
import type { FileBlobOutcome } from './form-files.service';

/**
 * PURGE A FILE N DAYS AFTER AN EVENT, AND KEEP WHAT CITES IT - one mechanism, two starting points.
 *
 * Decision D41 (docs/wiki/bookings-chantier.md): a form answer's file goes N days after the DATE OF
 * THE ANSWER, a booking's N days after the END OF ITS SLOT. The event is the caller's to name, so it
 * is a PARAMETER (`start`) and nothing here knows which feature it serves.
 *
 * THE STATE IS THE ROW. The caller selects candidates by a predicate over durable columns and hands
 * them over; this function deletes the blob FIRST and only then lets the caller clear its reference
 * (`markGone`), and only for a blob the media service said is gone (`deleted`, or `absent` - already
 * gone, which is what a rerun after a crash meets). A failure leaves the reference in place, so the
 * next run finds the same row: idempotent from the row alone, no "last run" marker, no window.
 *
 * THE ALLOWLIST is twofold: the caller's query names only its own table's rows, and the media service
 * deletes only an object of class `form-file` uploaded by the named owner - an id quoted in some
 * answer, pointing at anything else, comes back `refused` and is left alone.
 *
 * Every candidate this function does not finish is returned in `kept`, so the caller can exclude it
 * from its own next query in the same run: one file the store will not delete never spins the loop.
 */

/** One file whose retention may have run out. */
export interface FileRetentionCandidate {
  /** The media id - also the caller's row id. */
  fileId: string;
  /** Who uploaded it: the media service deletes it on that name only. */
  ownerId: string;
  /** The event retention counts from: the answer's date (forms), the slot's end (bookings). */
  start: Date;
  /** How many days after `start` the file goes. */
  retentionDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant a file's retention runs out. */
export function fileRetentionDeadline(start: Date, retentionDays: number): Date {
  return new Date(start.getTime() + retentionDays * DAY_MS);
}

/** Whether a file's retention has run out at `now`. */
export function isFileRetentionDue(candidate: FileRetentionCandidate, now: Date): boolean {
  return fileRetentionDeadline(candidate.start, candidate.retentionDays).getTime() <= now.getTime();
}

/** What one call did, per file. */
export interface FileRetentionResult {
  /** Blob gone AND reference cleared. */
  gone: string[];
  /** Not finished - to exclude from the caller's next query in this run, and retried next run. */
  kept: string[];
  /** Blob outcomes, for the caller's summary line. */
  blobs: Record<FileBlobOutcome, number>;
}

/** What the purge needs from its caller. */
export interface FileRetentionDeps {
  /** Deletes blobs on their owner's name; one outcome per id. Throws on a transport failure. */
  deleteBlobs: (
    items: Array<{ mediaId: string; ownerId: string }>
  ) => Promise<Record<string, FileBlobOutcome>>;
  /** Clears the caller's reference to a file whose blob is gone. */
  markGone: (fileId: string) => Promise<void>;
}

/** The columns a due file is selected with, by either scheduler. */
export interface DueFileRow {
  id: string;
  uploaderId: string;
  start: Date | string;
  days: number | string;
}

/** What a run accumulates across its passes: files kept for the next run, and blob outcomes. */
export interface FileRetentionTotals {
  kept: number;
  blobs: Record<FileBlobOutcome, number>;
}

/**
 * ONE PREDICATE OF A RUN, LOOPED UNTIL IT SELECTS NOTHING - the loop both the forms' scheduler and
 * the bookings' one run (`FormFileRetentionScheduler`, `BookingRetentionScheduler`). What is kept is
 * excluded from the next query of the same pass, so one file the store will not delete never spins
 * it; a candidate neither gone nor kept stops the pass with an error, since it would be selected
 * again for ever.
 *
 * @param counts Due and gone counts of THIS pass, incremented.
 * @param totals The run's kept count and blob outcomes, incremented.
 * @param select The caller's query, given the ids to exclude; `[]` when nothing is due.
 */
export async function runFileRetentionPass(
  counts: { due: number; gone: number },
  totals: FileRetentionTotals,
  now: Date,
  select: (excluded: string[]) => Promise<DueFileRow[]>,
  deps: FileRetentionDeps,
  logger: Logger,
  tag: string
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
    const result = await purgeExpiredFiles(candidates, now, deps, logger, tag);
    counts.gone += result.gone.length;
    totals.kept += result.kept.length;
    for (const [outcome, n] of Object.entries(result.blobs)) {
      totals.blobs[outcome as FileBlobOutcome] += n;
    }
    excluded.push(...result.kept);
    const settled = new Set([...result.gone, ...result.kept]);
    const unsettled = candidates.filter((c) => !settled.has(c.fileId));
    if (unsettled.length > 0) {
      logger.error(`${tag} ${unsettled.length} file(s) neither gone nor kept - stopping`);
      return;
    }
  }
}

/**
 * Deletes the blobs of the DUE candidates, then clears each reference whose blob is gone. A
 * candidate not due by its own `start` and `retentionDays` is refused here whatever the caller's
 * query said - the destructive step re-checks the predicate it acts on.
 *
 * Logs one line per file deleted and one per failure, under `tag`.
 */
export async function purgeExpiredFiles(
  candidates: FileRetentionCandidate[],
  now: Date,
  deps: FileRetentionDeps,
  logger: Logger,
  tag: string
): Promise<FileRetentionResult> {
  const result: FileRetentionResult = {
    gone: [],
    kept: [],
    blobs: { deleted: 0, absent: 0, refused: 0, failed: 0 },
  };

  const due: FileRetentionCandidate[] = [];
  for (const candidate of candidates) {
    if (isFileRetentionDue(candidate, now)) {
      due.push(candidate);
    } else {
      result.kept.push(candidate.fileId);
      logger.error(
        `${tag} file=${candidate.fileId} selected but not due until ${fileRetentionDeadline(candidate.start, candidate.retentionDays).toISOString()} - left alone`
      );
    }
  }
  if (due.length === 0) return result;

  let outcomes: Record<string, FileBlobOutcome>;
  try {
    outcomes = await deps.deleteBlobs(
      due.map((candidate) => ({ mediaId: candidate.fileId, ownerId: candidate.ownerId }))
    );
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    logger.warn(
      `${tag} ${due.length} file(s) kept for the next run, the media service did not answer: ${code ?? ''} ${
        e instanceof Error && e.message ? e.message : String(e)
      }`.replace(/\s+/g, ' ')
    );
    result.kept.push(...due.map((candidate) => candidate.fileId));
    return result;
  }

  for (const candidate of due) {
    // An id the media service did not answer for is NOT a success: the blob may still be there.
    const outcome = outcomes[candidate.fileId] ?? 'failed';
    result.blobs[outcome] += 1;
    if (outcome === 'failed') {
      logger.warn(`${tag} file=${candidate.fileId} could not be deleted - kept for the next run`);
      result.kept.push(candidate.fileId);
      continue;
    }
    if (outcome === 'refused') {
      logger.error(
        `${tag} file=${candidate.fileId} refused by the media service (not a form file of ${candidate.ownerId}) - left alone`
      );
      result.kept.push(candidate.fileId);
      continue;
    }
    try {
      await deps.markGone(candidate.fileId);
    } catch (e) {
      logger.warn(
        `${tag} file=${candidate.fileId} blob ${outcome}, but its row could not be updated - retried next run: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      result.kept.push(candidate.fileId);
      continue;
    }
    result.gone.push(candidate.fileId);
    logger.log(
      `${tag} file=${candidate.fileId} ${outcome === 'deleted' ? 'deleted' : 'already gone'}, ${candidate.retentionDays} day(s) after ${candidate.start.toISOString()}`
    );
  }
  return result;
}
