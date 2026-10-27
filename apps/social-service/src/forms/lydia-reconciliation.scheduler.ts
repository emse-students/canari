import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  isLydiaReconcileEnabled,
  LydiaReconciliationService,
  type ReconcileCounts,
} from './lydia-reconciliation.service';

/** One summary's counts, in the order the line prints them. */
function formatCounts(counts: ReconcileCounts): string {
  return (
    `examined=${counts.examined} settled=${counts.settled} released=${counts.released} ` +
    `unchanged=${counts.unchanged} skipped-unverified=${counts.skippedUnverified} ` +
    `unavailable=${counts.unavailable} errors=${counts.errors}`
  );
}

/**
 * Runs the boutique half of the Lydia reconciliation, and reports both halves once an hour.
 *
 * The FORM half runs in `FormReminderScheduler`'s expiry tick instead, immediately before the
 * expiry, because the order is the point: a form answer must be read while it is still `pending`.
 *
 * Two replicas may run this at once during a deploy's overlap. Every write goes through a settle
 * path that locks the row and moves it out of the status the sweep selects on, so a second
 * settlement finds nothing to do - the argument the integration spec MEASURES for one sweep against
 * seven payer returns on one row; two sweeps take the same locks, and were not measured apart.
 */
@Injectable()
export class LydiaReconciliationScheduler implements OnModuleInit {
  private readonly logger = new Logger(LydiaReconciliationScheduler.name);
  /** Set while a sweep runs, so a slow one is not overlapped by the next tick in this process. */
  private running = false;

  constructor(private readonly reconciliation: LydiaReconciliationService) {}

  /** ONE line at startup saying whether the sweep may ask Lydia anything on this estate. */
  onModuleInit(): void {
    if (isLydiaReconcileEnabled()) {
      this.logger.log('[RECONCILE] Lydia reconciliation sweep ON (LYDIA_RECONCILE_ENABLED=true)');
    } else {
      this.logger.log(
        '[RECONCILE] Lydia reconciliation sweep OFF (LYDIA_RECONCILE_ENABLED is not true): no request/state read, no row settled by the sweep'
      );
    }
  }

  /** Every 5 minutes, at the expiry tick's cadence: boutique attempts whose request has ended. */
  @Cron('*/5 * * * *')
  async sweepProductCheckouts(): Promise<void> {
    if (this.running) {
      this.logger.debug('[RECONCILE] previous boutique sweep still running - this tick skipped');
      return;
    }
    this.running = true;
    try {
      await this.reconciliation.sweepProductCheckouts();
    } catch (err: unknown) {
      // The selection itself failed (the database): no row was examined.
      this.logger.error(
        `[RECONCILE] boutique sweep failed before reading any row: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Hourly: ONE line of what the reconciliation did since the last one, even when it did nothing -
   * a line that stops appearing is how a sweep that stopped running is seen. Counts are this
   * process's, since its last line (a restart starts them again).
   */
  @Cron('0 * * * *')
  async reportHourly(): Promise<void> {
    // Switched off, the startup line is the whole report: nothing ran, nothing to count.
    if (!isLydiaReconcileEnabled()) return;
    const { forms, products } = this.reconciliation.takeCounts();
    let withoutKey: string;
    try {
      withoutKey = String(await this.reconciliation.openWithoutKey());
    } catch (err: unknown) {
      withoutKey = 'unreadable';
      this.logger.warn(
        `[RECONCILE] could not count the attempts whose Business holds no key: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    this.logger.log(
      `[RECONCILE] last hour - forms: ${formatCounts(forms)}; boutique: ${formatCounts(products)}; ` +
        `ended boutique attempts left open with no Business key: ${withoutKey}`
    );
  }
}
