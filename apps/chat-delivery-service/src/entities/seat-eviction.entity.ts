import { Entity, PrimaryColumn, Column, UpdateDateColumn, Index } from 'typeorm';

/**
 * The durable record that a person was cut off a group's seats - one row per `(groupId, userId)`,
 * rewritten by every eviction (migration 036).
 *
 * **WHAT IT IS FOR: A SEAT IS WRITTEN ONLY AGAINST A CLAIM NO EVICTION HAS OVERTAKEN.** An activation
 * that creates a seat (an accepted commit's committer, a key group's publisher) is decided by a check
 * made BEFORE the seat lock - the roster, or social-service's entitlement over HTTP - and an HTTP call
 * is never made under a lock. So the writer reads this row first ({@link claimSeat}), makes its
 * check, and writes the seat under the group's seat lock only if the row has not moved since
 * ({@link seatClaimHolds}). An eviction rewrites the row under the same lock, so either it ran before
 * the claim (and the check sees the departure), after the claim (and the generation differs), or
 * after the write (and it deletes the seat). The mechanism: `docs/wiki/protocols/channel-encryption.md`
 * ("WP-21, and the gate it had nowhere to live").
 *
 * `owed` is a key group's departure IN PROGRESS: social-service evicts before its roster write and
 * again after it, and between the two its entitlement still answers `true`. The first eviction sets
 * it, the second clears it; while it is set no seat is written for that person. A second eviction
 * that never arrives leaves it set, and the hourly drain (`MessagingService.drainOwedSeatEvictions`)
 * asks social-service and settles it - so a lost call is retried from durable state, not read by hand.
 *
 * Deleted with the group (`GROUP_OWNED_TABLES`) and with the account.
 */
@Entity('dm_seat_evictions')
@Index('IDX_dm_seat_evictions_owed', ['owed'])
export class SeatEviction {
  /** Group the person was cut off. */
  @PrimaryColumn({ type: 'uuid' })
  groupId: string;

  /** Person cut off. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** Incremented by every eviction of this person from this group; a claim compares it. */
  @Column({ type: 'integer', default: 0 })
  generation: number;

  /** A key group's departure whose post-roster eviction has not arrived yet. */
  @Column({ type: 'boolean', default: false })
  owed: boolean;

  /** When an eviction last rewrote the row (diagnostic only - nothing is decided on it). */
  @UpdateDateColumn()
  updatedAt: Date;
}
