import type { Logger } from '@nestjs/common';
import { describeFailure } from '../account-erasure/erasure-policy';

/** What one durable queue of core-service hands the runner. */
export interface DurableQueueSpec {
  /** The log tag of its lines (`[ERASURE]`, `[ALUMNI_MERGE_SITE]`). */
  tag: string;
  logger: Logger;
  /** Claims and runs every due job until none is left. Throws what failed; the runner logs it. */
  drainOnce: () => Promise<void>;
  /** The daily report: accuses what is overdue or blocked. Never throws (it reports its own failure). */
  report: () => Promise<unknown>;
  /** How often the worker looks for due jobs; a request also starts a drain at once. */
  drainIntervalMs: number;
  /** How often the report runs, and how long after boot it first runs. */
  reportIntervalMs: number;
  firstReportDelayMs: number;
}

/**
 * THE ONE RUNNER OF core-service's DURABLE QUEUES - the account erasure's (`account_erasure_jobs`) and
 * the Alumni merge's sibling-site jobs (`alumni_merge_site_jobs`, D54) - factorized so the two share
 * one implementation of what makes a queue a queue rather than a call: the periodic drain, the
 * single flight, the daily report and their teardown. Each queue keeps its own table and its own
 * claim (a `FOR UPDATE SKIP LOCKED` that pushes the due time forward by a lease, so a second process
 * skips what the first holds), and both back off with the same `retryDelayMs` and describe a failure
 * with the same `describeFailure` (`erasure-policy.ts`).
 *
 * The state is in the database: a drain that fails is logged at error and the next tick picks the
 * queue up again. The timers never hold the process open on shutdown.
 */
export class DurableQueueRunner {
  private drainTimer: NodeJS.Timeout | null = null;
  private reportTimer: NodeJS.Timeout | null = null;
  private firstReport: NodeJS.Timeout | null = null;
  /** The drain in flight, so overlapping triggers share it instead of racing it. */
  private draining: Promise<void> | null = null;

  constructor(private readonly spec: DurableQueueSpec) {}

  /** Starts the periodic drain and the report. */
  start(): void {
    this.drainTimer = setInterval(() => void this.drain(), this.spec.drainIntervalMs);
    this.reportTimer = setInterval(() => void this.spec.report(), this.spec.reportIntervalMs);
    this.firstReport = setTimeout(() => void this.spec.report(), this.spec.firstReportDelayMs);
    this.drainTimer.unref?.();
    this.reportTimer.unref?.();
    this.firstReport.unref?.();
  }

  /** Stops every timer; a drain in flight finishes on its own. */
  stop(): void {
    for (const t of [this.drainTimer, this.reportTimer]) if (t) clearInterval(t);
    if (this.firstReport) clearTimeout(this.firstReport);
    this.drainTimer = this.reportTimer = this.firstReport = null;
  }

  /** Runs every due job once. Single-flight inside the process. */
  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.spec
        .drainOnce()
        .catch((err: unknown) => {
          // The queue survives in the database; the next tick picks it up again.
          this.spec.logger.error(
            `${this.spec.tag} drain failed: ${describeFailure(err)} ${String(err)}`
          );
        })
        .finally(() => {
          this.draining = null;
        });
    }
    return this.draining;
  }
}
