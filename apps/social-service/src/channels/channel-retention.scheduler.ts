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
 *
 * The client bounds this number from below by `GRAINE_RETENTION_FLOOR_DAYS`
 * (`frontend/src/lib/utils/graine/retention.ts`), so a server-provided value can never shorten a
 * device's seed lifetime. CHANGING this window means changing that floor in the same change;
 * `frontend/src/lib/utils/graine/retentionFloorPin.test.ts` fails while they differ (this file is
 * in ci.yml's frontend path filter so that a PR touching only it runs that test).
 */
export const CHANNEL_MESSAGE_RETENTION_DAYS = 365;

/**
 * How long a deleted salon message's client-id tombstone is kept (migration 090). The user's
 * decision of 2026-10-18.
 *
 * A tombstone exists for ONE reader: a send repeated after its message was deleted - its first
 * answer lost, the app killed, the message removed meanwhile - which it refuses (410) instead of
 * posting the removed message again. Such a repeat comes from a device's unsent ledger
 * (`salonUnsent.ts`), resent when the app next starts, so it arrives within the days a phone stays
 * closed. A device closed for longer than this, holding a send its message's delete overtook, would
 * post it again on its next start: that is the residual the 30 days accept, for a row naming an
 * author that would otherwise outlive the deleted message for as long as the salon did.
 */
export const CHANNEL_MESSAGE_TOMBSTONE_RETENTION_DAYS = 30;

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
   * Daily at 03:50, after the message purge. The clock is read HERE, once, and handed down: what
   * decides a tombstone's age is its own `deletedAt`, written in the transaction of the delete, so
   * a run repeated, skipped or late deletes exactly the rows past the window at that instant.
   */
  @Cron('50 3 * * *')
  async purgeExpiredClientTombstones(): Promise<void> {
    try {
      const deleted = await this.purgeTombstonesOnce(new Date());
      if (deleted > 0) {
        this.logger.log(
          `[GC] channel_message_client_tombstones: ${deleted} deleted (older than ` +
            `${CHANNEL_MESSAGE_TOMBSTONE_RETENTION_DAYS} days)`
        );
      } else {
        this.logger.debug('[GC] channel_message_client_tombstones: none past the window');
      }
    } catch (e) {
      // ERROR, not a warning: a tombstone kept past its window breaks what the privacy policy says.
      this.logger.error('[GC] purgeExpiredClientTombstones failed', e);
    }
  }

  /**
   * Deletes the client-id tombstones older than {@link CHANNEL_MESSAGE_TOMBSTONE_RETENTION_DAYS}
   * at `now`. Idempotent: a second run at the same instant finds nothing. `now` is a parameter so a
   * test fixes the instant instead of reading a wall clock.
   *
   * @returns how many rows went
   */
  async purgeTombstonesOnce(now: Date): Promise<number> {
    const [, rowCount]: [unknown, number] = await this.messageRepo.manager.query(
      `DELETE FROM channel_message_client_tombstones
        WHERE "deletedAt" < $1::timestamptz - make_interval(days => $2)`,
      [now.toISOString(), CHANNEL_MESSAGE_TOMBSTONE_RETENTION_DAYS]
    );
    return rowCount ?? 0;
  }

  /**
   * The delete itself, separated so a test can call it without a scheduler.
   *
   * @returns how many rows went
   */
  async purgeOnce(): Promise<number> {
    // TypeORM's postgres `query()` answers a DELETE as `[rows, rowCount]`, never as an object with
    // a `rowCount` - this read `res.rowCount`, got undefined, and returned 0 for every run, so the
    // `[GC]` line below could never be written (measured against a real PostgreSQL 2026-10-02).
    const [, rowCount]: [unknown, number] = await this.messageRepo.manager.query(
      `DELETE FROM channel_messages
        WHERE "createdAt" < NOW() - make_interval(days => $1)
          AND pinned = false`,
      [CHANNEL_MESSAGE_RETENTION_DAYS]
    );
    return rowCount ?? 0;
  }
}
