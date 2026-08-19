import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelMessage } from './entities/channel-message.entity';

/**
 * How long a community message is kept. The user's decision of 2026-08-18.
 *
 * A YEAR is the whole window, and it is one number rather than two: the seeds that open these
 * messages are dropped by the SAME boundary, but not by a second clock - the device asks which of
 * its sessions this table still names (`liveGraineSessions`) and forgets the rest. A client-side
 * clock would have been a second copy of this number, and two windows meant to be one are exactly
 * what drifts.
 */
export const CHANNEL_MESSAGE_RETENTION_DAYS = 365;

/**
 * Deletes community messages past the retention window.
 *
 * PINNED MESSAGES ARE EXEMPT, and that is not a softening of the window: pinning is somebody
 * deliberately saying this one outlives the scroll. Deleting it at a year would destroy the one
 * kind of message a human explicitly marked as durable, silently, and pinned sets are small and
 * bounded per channel. The exemption is safe only because seed liveness is DERIVED from this table
 * rather than from a matching clock - a pinned message keeps its session alive by still naming it,
 * so it never becomes ciphertext nobody holds the key to.
 *
 * ARMED ON DEPLOY - the user's decision of 2026-08-19, taken against the recommendation to leave it
 * disarmed until the figure was read. The figure at the time was zero: `channel_messages` held no
 * rows at all, every community having been deleted by THE CUT on 2026-08-18.
 */
@Injectable()
export class ChannelRetentionScheduler {
  private readonly logger = new Logger(ChannelRetentionScheduler.name);

  constructor(
    @InjectRepository(ChannelMessage)
    private readonly messageRepo: Repository<ChannelMessage>
  ) {}

  /** Daily at 03:45, after the other GC jobs rather than beside them. */
  @Cron('45 3 * * *')
  async purgeExpiredChannelMessages(): Promise<void> {
    try {
      const deleted = await this.purgeOnce();
      if (deleted > 0) {
        this.logger.log(
          `[GC] channel_messages: ${deleted} deleted (older than ` +
            `${CHANNEL_MESSAGE_RETENTION_DAYS} days, pinned exempt)`
        );
      }
    } catch (e) {
      this.logger.warn('[GC] purgeExpiredChannelMessages failed', e);
    }
  }

  /**
   * The delete itself, separated so a test can call it without a scheduler.
   *
   * @returns how many rows went
   */
  async purgeOnce(): Promise<number> {
    const res: { rowCount?: number } = await this.messageRepo.manager.query(
      `DELETE FROM channel_messages
        WHERE "createdAt" < NOW() - make_interval(days => $1)
          AND pinned = false`,
      [CHANNEL_MESSAGE_RETENTION_DAYS]
    );
    return res.rowCount ?? 0;
  }
}
