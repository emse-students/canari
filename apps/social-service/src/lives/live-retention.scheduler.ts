import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LivesService } from './lives.service';

/** How many ended lives one query takes; the run loops until none is left. */
const BATCH = 50;

/** What one run did, returned for the test and summarised in the log. */
export interface LiveSweepReport {
  /** Open lives this run ended (`dropped` or `max_duration`). */
  ended: number;
  /** Ended lives whose segments and row were deleted. */
  deleted: number;
  /** Ended lives kept for the next run: the store refused, or still listed something. */
  kept: number;
}

/**
 * The live sweep (Q5, Q10 of docs/wiki/frontend/modules/live.md), every 30 seconds.
 *
 * 1. ENDS the open lives whose broadcaster stopped sending for the reconnect window, or whose hour
 *    is up - writing the end as the row's durable state (`LivesService.endDue`).
 * 2. DELETES every ended live: its segments from the store, then its row, the row only once the
 *    store proves the live's prefix empty (`LivesService.purgeEnded`).
 *
 * THE STATE IS THE ROW: a live with `endedAt` and a row is due, a deleted row is done - no "last
 * run", no marker. Idempotent: a crash between the store and the row leaves an ended row whose
 * prefix the next run finds empty, and the row goes then. It also catches every end that did not
 * purge at once (the broadcaster's end with the store down, a `max_duration` written by an ingest,
 * an account erasure).
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
    const report: LiveSweepReport = { ended: 0, deleted: 0, kept: 0 };
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

    if (report.ended + report.deleted + report.kept > 0) {
      this.logger.log(
        `[LIVE_GC] ended=${report.ended} deleted=${report.deleted} kept=${report.kept}`
      );
    }
    return report;
  }
}
