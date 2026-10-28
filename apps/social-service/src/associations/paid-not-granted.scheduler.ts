import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PurchaseRecordService } from '../users/purchase-record.service';
import { UserTagService } from '../users/user-tag.service';

const TAG = '[PAID_NOT_GRANTED]';
const ORPHAN_TAG = '[ORPHAN_TIER_TAGS]';

/**
 * THE TIERS PAID FOR AND NOT GRANTED, AND THE TAGS OF DELETED TIERS, REPORTED
 * (docs/wiki/cotisations.md "Rising to a higher tier", "A tier deleted while people still hold it").
 *
 * A settlement or a paid form whose cotisation tier is no longer a rise over the one the buyer holds
 * records the payment `paid_not_granted` and grants nothing: money was taken, and a refund or a
 * manual grant is owed. The ERROR line written at that moment is read once, if at all; this reads
 * the durable marker every hour and prints ONE line - `log` with `count=0`, `error` while any row
 * carries it. The association's purchases list and export show which rows.
 *
 * The same hour counts the ACTIVE tags of a tier that no longer exists (`countOrphanTierTags`): each
 * holder is refused every other tier (`TIER_NOT_RANKABLE`) until a manager grants them one, so a
 * non-zero count is a WARN naming work owed - and it is said here once an hour, never once per
 * request that reads such a tag.
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
    private readonly tags: UserTagService
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
      `${TAG} count=${count}: cotisation tier(s) paid for and NOT granted - a refund or a manual ` +
        "grant is owed; the rows are marked in the association's purchases"
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
