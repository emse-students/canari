import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PurchaseRecordService } from '../users/purchase-record.service';

const TAG = '[PAID_NOT_GRANTED]';

/**
 * THE TIERS PAID FOR AND NOT GRANTED, REPORTED (docs/wiki/cotisations.md "Rising to a higher tier").
 *
 * A settlement or a paid form whose cotisation tier is no longer a rise over the one the buyer holds
 * records the payment `paid_not_granted` and grants nothing: money was taken, and a refund or a
 * manual grant is owed. The ERROR line written at that moment is read once, if at all; this reads
 * the durable marker every hour and prints ONE line - `log` with `count=0`, `error` while any row
 * carries it. The association's purchases list and export show which rows.
 *
 * NO USER DATA in the line: a count only. On zero it still prints, because that line is the report's
 * own liveness proof - without it, a report that stopped running would read like an empty count.
 */
@Injectable()
export class PaidNotGrantedScheduler {
  private readonly logger = new Logger(PaidNotGrantedScheduler.name);

  constructor(private readonly purchases: PurchaseRecordService) {}

  /** Hourly, at :29 - off the minutes the other hourly jobs of this service use (:00, :23, :37, :41, :47, :53). */
  @Cron('29 * * * *')
  async report(): Promise<void> {
    try {
      await this.reportOnce();
    } catch (e) {
      // A report that cannot read its rows is itself an alarm: the marker is unwatched.
      this.logger.error(
        `${TAG} could not count the purchases paid and not granted - unwatched this hour: ${String(e)}`
      );
    }
  }

  /** One reading and its line, separated so a test can call it without a scheduler. */
  async reportOnce(): Promise<number> {
    this.logger.debug(`${TAG} counting the purchases paid and not granted`);
    const count = await this.purchases.countPaidNotGranted();
    if (count === 0) {
      this.logger.log(`${TAG} count=0`);
      return count;
    }
    this.logger.error(
      `${TAG} count=${count}: purchase(s) paid for and NOT delivered (a tier, a deleted product, a ` +
        'form paid with no seat) - check what each buyer holds now, then refund or grant by hand; ' +
        "the rows are marked in the association's purchases"
    );
    return count;
  }
}
