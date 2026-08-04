import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ProductsService } from './products.service';

/**
 * Re-sends Cercle top-up webhooks that failed, on a backoff.
 *
 * Every failure this catches is money a member paid Canari and never received on the Cercle. Until
 * now the only recovery was an admin noticing the row in the dashboard and pressing retry, so an
 * outage on the Cercle side - or a deploy that took the receiver down for a minute - cost a manual
 * intervention per top-up.
 *
 * Thin on purpose: the ladder, the backoff and the "give up and ask a human" rule all live in
 * `ProductsService`, next to the dispatch they mirror.
 */
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
        this.logger.log(`[CERCLE] automatic retry: ${delivered}/${attempted} delivered`);
      }
    } catch (e) {
      // Swallowed rather than thrown: an unhandled rejection in a cron handler takes the process
      // down, and a failed sweep must not cost the service.
      this.logger.warn('[CERCLE] automatic retry sweep failed', e);
    }
  }
}
