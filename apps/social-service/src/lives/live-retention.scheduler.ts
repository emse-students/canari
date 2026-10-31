import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LivesService } from './lives.service';

/** How many ended lives one query takes; the run loops until none is left. */
const BATCH = 50;

/** What one run did, returned for the test and summarised in the log. */
export interface LiveSweepReport {
  /** Open lives this run ended (`dropped`). */
  ended: number;
  /** Ended lives whose segments and row were deleted. */
  deleted: number;
  /** Ended lives kept for the next run: the store refused, still listed something, or a segment is storing. */
  kept: number;
  /** Segment folders with no live row behind them, emptied by the orphan reaper. */
  orphans: number;
  /** Staff cuts past `LIVE_CUT_RETENTION_MS`, deleted from `live_cuts`. */
  cutsPruned: number;
  /** Reported chat lines erased: their report handled, or the 90-day bound reached (WP-L8b). */
  chatLinesErased: number;
  /** Plaintext live keys sealed at rest (migration 110's backfill). */
  keysSealed: number;
  /** Plaintext live keys this run could not seal - each logged at ERROR, retried next run. */
  keysUnsealed: number;
}

/**
 * The live sweep (Q5, Q10 of docs/wiki/frontend/modules/live.md), every 30 seconds.
 *
 * 0. SEALS every live key still stored in the clear (`LivesService.sealPlaintextKeys`, the backfill
 *    of migration 110) - first, so a live this run purges is not left for it.
 * 1. ENDS the open lives whose broadcaster stopped sending for the reconnect window (a live has no
 *    longest duration) - writing the end as the row's durable state (`LivesService.endDue`).
 * 2. DELETES every ended live: its segments from the store, then its row, the row only once the
 *    store proves the live's prefix empty (`LivesService.purgeEnded`).
 * 3. REAPS every segment folder with no live row behind it - a store that outlived its own timeout
 *    and landed after its live's purge (`LivesService.reapOrphans`, a row-state rule, no clock) -
 *    and deletes the `live_starts` rows older than the hour they are counted in, and the `live_cuts`
 *    rows past their retention (`LIVE_CUT_RETENTION_MS`).
 * 4. ERASES every reported chat line whose report was handled, or that was kept
 *    `LIVE_CHAT_REPORT_MAX_KEEP_MS` unhandled (`LivesService.pruneReportedChatLines`, WP-L8b).
 *
 * THE STATE IS THE ROW: a live with `endedAt` and a row is due, a deleted row is done - no "last
 * run", no marker. Idempotent: a crash between the store and the row leaves an ended row whose
 * prefix the next run finds empty, and the row goes then. It also catches every end that did not
 * purge at once (the broadcaster's end with the store down, an account erasure).
 *
 * ISOLATION: a `try` per live, and a live kept by this run is excluded from its own next query, so
 * one live the store refuses neither stops the batch nor spins the loop.
 *
 * Runs whatever `LIVE_ENABLED` says: a live started while the switch was on is still ended and
 * deleted after it is turned off. On an estate that never had one, it is one indexed empty query.
 *
 * OBSERVED by the `[LIVE_GC]` line, printed only when something was done, and the per-live `warn`s.
 */
@Injectable()
export class LiveRetentionScheduler {
  private readonly logger = new Logger(LiveRetentionScheduler.name);
  private running = false;

  constructor(private readonly lives: LivesService) {}

  @Cron('*/30 * * * * *')
  async sweep(): Promise<void> {
    if (this.running) {
      this.logger.warn('[LIVE_GC] the previous run is still going - this tick is skipped');
      return;
    }
    this.running = true;
    try {
      await this.sweepOnce();
    } catch (e) {
      this.logger.warn(`[LIVE_GC] run failed before it could finish: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }

  /** The whole run, separated so a test can call it without a scheduler. */
  async sweepOnce(): Promise<LiveSweepReport> {
    const report: LiveSweepReport = {
      ended: 0,
      deleted: 0,
      kept: 0,
      orphans: 0,
      cutsPruned: 0,
      chatLinesErased: 0,
      keysSealed: 0,
      keysUnsealed: 0,
    };
    // Its own `try`: a database refusal here must not cost the ends and purges below.
    try {
      const keys = await this.lives.sealPlaintextKeys();
      report.keysSealed = keys.sealed;
      report.keysUnsealed = keys.failed;
    } catch (e) {
      this.logger.error(`[LIVE_GC] plaintext key sealing skipped this run: ${String(e)}`);
    }
    report.ended = (await this.lives.endDue()).length;

    const kept: string[] = [];
    for (;;) {
      const ids = await this.lives.endedLiveIds(kept, BATCH);
      if (ids.length === 0) break;
      for (const id of ids) {
        try {
          if ((await this.lives.purgeEnded(id)) === 'deleted') {
            report.deleted += 1;
            continue;
          }
        } catch (e) {
          const code = (e as { code?: string } | null)?.code;
          this.logger.warn(
            `[LIVE_GC] ${id} kept for the next run: ${code ?? ''} ${
              e instanceof Error ? e.message : String(e)
            }`.replace(/\s+/g, ' ')
          );
        }
        report.kept += 1;
        kept.push(id);
      }
    }

    // After the purges, so a live this run deleted is not met again as an orphan. Its own `try`: a
    // store that cannot list must not cost the report of what the purges did.
    try {
      report.orphans = (await this.lives.reapOrphans()).reaped;
    } catch (e) {
      this.logger.warn(`[LIVE_GC] orphan reaper skipped this run: ${String(e)}`);
    }
    // Each prune in its own `try`, for the same reason: a throw in one must not skip the other, nor
    // cost the report.
    try {
      await this.lives.pruneStarts();
    } catch (e) {
      this.logger.warn(`[LIVE_GC] start prune skipped this run: ${String(e)}`);
    }
    try {
      report.cutsPruned = await this.lives.pruneCuts();
    } catch (e) {
      this.logger.warn(`[LIVE_GC] cut prune skipped this run: ${String(e)}`);
    }
    try {
      report.chatLinesErased = await this.lives.pruneReportedChatLines();
    } catch (e) {
      this.logger.warn(`[LIVE_GC] reported chat line erasure skipped this run: ${String(e)}`);
    }

    if (Object.values(report).some((n) => n > 0)) {
      this.logger.log(
        `[LIVE_GC] ended=${report.ended} deleted=${report.deleted} kept=${report.kept} orphans=${report.orphans} cutsPruned=${report.cutsPruned} chatLinesErased=${report.chatLinesErased} keysSealed=${report.keysSealed} keysUnsealed=${report.keysUnsealed}`
      );
    }
    return report;
  }
}
