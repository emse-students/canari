import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ProductsService } from './products.service';

/**
 * Re-sends Cercle top-up webhooks that failed, on a backoff - and the PARKED ones on a slow cadence,
 * since Le Cercle's answer to a re-send (200 once the member's first sign-in credited it) is the one
 * way this side learns a park ended.
 *
 * Every failure this catches is money a member paid Canari and never received on the Cercle. Until
 * now the only recovery was an admin noticing the row in the dashboard and pressing retry, so an
 * outage on the Cercle side - or a deploy that took the receiver down for a minute - cost a manual
 * intervention per top-up.
 *
 * Thin on purpose: the ladder, the backoff and the "give up and ask a human" rule all live in
 * `ProductsService`, next to the dispatch they mirror.
 */
/**
 * How long a top-up may wait PARKED at Le Cercle before the daily report names it as a long wait.
 * A product definition, not a timeout: nothing is retried or moved when it elapses, the count only
 * turns into a WARN asking someone to look at `/admin/cercle`.
 */
export const LONG_PARKED_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CercleDeliveryScheduler {
  private readonly logger = new Logger(CercleDeliveryScheduler.name);

  constructor(private readonly products: ProductsService) {}

  /**
   * Every 5 minutes - the shortest backoff step, so nothing waits appreciably longer than the step
   * it was given.
   */
  @Cron('*/5 * * * *')
  async retryFailedCercleDeliveries() {
    try {
      const { delivered, attempted } = await this.products.retryDueWebhookDeliveries();
      if (attempted > 0) {
        this.logger.log(`[CERCLE] automatic retry: ${delivered}/${attempted} delivered or parked`);
      }
    } catch (e) {
      // Swallowed rather than thrown: an unhandled rejection in a cron handler takes the process
      // down, and a failed sweep must not cost the service.
      this.logger.warn('[CERCLE] automatic retry sweep failed', e);
    }
  }

  /**
   * Daily at 03:25 - THE PARKED TOP-UPS, REPORTED. A parked delivery is money a member paid that Le
   * Cercle holds until their first sign-in there. The sweep re-sends it every six hours and settles
   * it `delivered` once Le Cercle answers 200, so a row still parked after seven days is a member who
   * has really not signed in (or a re-send that keeps failing, its `lastError` on the admin page) -
   * money waiting that nobody would otherwise see. One line, counts only (no member, no amount):
   * `log` with the counts, `warn` while any has waited more than {@link LONG_PARKED_DAYS} days. It
   * prints on zero too - that line is the report's own proof it ran.
   */
  @Cron('25 3 * * *')
  async reportLongParked(now: Date = new Date()): Promise<void> {
    try {
      const olderThan = new Date(now.getTime() - LONG_PARKED_DAYS * DAY_MS);
      const { parked, old } = await this.products.countParkedDeliveries(olderThan);
      const line = `[CERCLE_PARKED] parked=${parked} older_than_${LONG_PARKED_DAYS}d=${old}`;
      if (old > 0) {
        this.logger.warn(
          `${line} - top-up(s) held by Le Cercle for a member who has not signed in there for more than ${LONG_PARKED_DAYS} days; see /admin/cercle`
        );
      } else {
        this.logger.log(line);
      }
    } catch (e) {
      // A report that cannot count is itself an alarm: the parked rows are unwatched today.
      this.logger.error(
        `[CERCLE_PARKED] could not count the parked top-ups - unwatched today: ${String(e)}`
      );
    }
  }
}
