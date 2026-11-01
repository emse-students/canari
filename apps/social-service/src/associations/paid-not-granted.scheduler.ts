import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { UserTagService } from '../users/user-tag.service';
import { RefundsService } from './refunds/refunds.service';

const TAG = '[PAID_NOT_GRANTED]';
const ORPHAN_TAG = '[ORPHAN_TIER_TAGS]';
const REFUND_TAG = '[LYDIA_REFUND_CONTRADICTED]';

/**
 * THE TIERS PAID FOR AND NOT GRANTED, AND THE TAGS OF DELETED TIERS, REPORTED
 * (docs/wiki/cotisations.md "Rising to a higher tier", "A tier deleted while people still hold it").
 *
 * A payment taken for something not delivered is recorded `paid_not_granted` (`PurchaseStatus`): a
 * boutique tier the settlement did not grant, a product deleted or a buyer erased before the payment
 * landed, a paid form that grants a tier and did not grant it. Money was taken, and a refund or a
 * manual grant is owed. The ERROR line written at that moment is read once, if at all; this reads
 * the durable marker every hour and prints ONE line - `log` with `count=0`, `error` while any row
 * carries it. The association's purchases list and export show which rows.
 *
 * A marked payment leaves the count only when a person CLOSES it from the purchases list, recording
 * whether the money was refunded or the tier granted by hand (`ProductsService.closePaidNotGranted`,
 * migration 113). No clock decides anything: a marked payment stays reported until its outcome is
 * recorded, and the mark itself stays on the record as history.
 *
 * The same hour counts the ACTIVE tags of a tier that no longer exists (`countOrphanTierTags`): each
 * holder is refused every other tier (`TIER_NOT_RANKABLE`) until a manager grants them one, so a
 * non-zero count is a WARN naming work owed - and it is said here once an hour, never once per
 * request that reads such a tag.
 *
 * The same hour counts the Lydia refunds whose LATE answer contradicts how they were settled
 * (`RefundsService.countContradicted`): money that went back on a refund settled as not refunded,
 * or the reverse - an ERROR while any exists, since the purchases list then says something Lydia
 * does not.
 *
 * NO USER DATA in the lines: counts only. On zero they still print, because that line is the
 * report's own liveness proof - without it, a report that stopped running would read like an empty
 * count.
 */
@Injectable()
export class PaidNotGrantedScheduler {
  private readonly logger = new Logger(PaidNotGrantedScheduler.name);

  constructor(
    private readonly purchases: PurchaseRecordService,
    private readonly tags: UserTagService,
    private readonly refunds: RefundsService
  ) {}

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
    // Its own `try`: one reading failing must not silence the other.
    try {
      await this.reportOrphansOnce();
    } catch (e) {
      this.logger.error(
        `${ORPHAN_TAG} could not count the tags of deleted tiers - unwatched this hour: ${String(e)}`
      );
    }
    try {
      await this.reportContradictedRefundsOnce();
    } catch (e) {
      this.logger.error(
        `${REFUND_TAG} could not count the refunds Lydia contradicted - unwatched this hour: ${String(e)}`
      );
    }
  }

  /** The contradicted Lydia refunds reading and its line. */
  async reportContradictedRefundsOnce(): Promise<number> {
    this.logger.debug(
      `${REFUND_TAG} counting the refunds Lydia answered late against their settlement`
    );
    const count = await this.refunds.countContradicted();
    if (count === 0) {
      this.logger.log(`${REFUND_TAG} count=0`);
      return count;
    }
    this.logger.error(
      `${REFUND_TAG} count=${count}: refund(s) whose late Lydia answer contradicts how they were ` +
        "settled - read the association's Lydia statement and correct the payment by hand"
    );
    return count;
  }

  /** One reading and its line, separated so a test can call it without a scheduler. */
  async reportOnce(): Promise<number> {
    this.logger.debug(`${TAG} counting the purchases paid, not granted and not closed`);
    const count = await this.purchases.countUnclosedPaidNotGranted();
    if (count === 0) {
      this.logger.log(`${TAG} count=0`);
      return count;
    }
    this.logger.error(
      `${TAG} count=${count}: purchase(s) paid for, NOT delivered and not closed (a tier not ` +
        'granted, a deleted product, an erased buyer, a form granting a tier that it did not grant - ' +
        'among them a tier already held when the payment landed: refund it, do not grant by hand) - ' +
        'check what each buyer holds now, then refund or grant ' +
        "by hand and record the outcome in the association's purchases"
    );
    return count;
  }

  /** The orphan tier tag reading and its line. */
  async reportOrphansOnce(): Promise<number> {
    this.logger.debug(`${ORPHAN_TAG} counting the active tags of deleted tiers`);
    const count = await this.tags.countOrphanTierTags();
    if (count === 0) {
      this.logger.log(`${ORPHAN_TAG} count=0`);
      return count;
    }
    this.logger.warn(
      `${ORPHAN_TAG} count=${count}: active tag(s) of a cotisation tier that no longer exists - ` +
        'each holder is refused other tiers until a manager grants them one'
    );
    return count;
  }
}
