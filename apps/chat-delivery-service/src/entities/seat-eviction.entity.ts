import { Entity, PrimaryColumn, Column, UpdateDateColumn, Index } from 'typeorm';

/**
 * The durable record that a person was cut off a group's seats - one row per `(groupId, userId)`,
 * rewritten by every eviction (migration 036).
 *
 * **WHAT IT IS FOR: A SEAT IS WRITTEN ONLY AGAINST A CLAIM NO EVICTION HAS OVERTAKEN.** An activation
 * that creates a seat (an accepted commit's committer, a commit's admit, a key group's publisher) is
 * decided by a check made BEFORE the seat lock - the roster, or social-service's entitlement over
 * HTTP - and an HTTP call is never made under a lock. So the writer reads this row first
 * ({@link claimSeat}), makes its check, and writes the seat under the group's seat lock only if the
 * row has not moved since ({@link seatClaimHolds}). An eviction rewrites the row under the same lock,
 * so either it ran before the claim (and the check sees the departure), after the claim (and the
 * generation differs), or after the write (and it deletes the seat). The mechanism:
 * `docs/wiki/protocols/channel-encryption.md` ("WP-21, and the gate it had nowhere to live").
 *
 * `owedDeparture` is a key group's departure IN PROGRESS, named by the generation of the eviction
 * that began it: social-service evicts before its roster write and again after it, and between the
 * two its entitlement still answers `true`. While it is set no seat is written for that person. The
 * second eviction names the departure it settles; one that never arrives is settled by the hourly
 * drain (`MessagingService.drainOwedSeatEvictions`), which asks social-service for THAT departure's
 * outcome - never the entitlement, which cannot tell a departure not yet committed from a rejoin.
 *
 * Deleted with the group (`GROUP_OWNED_TABLES`) and with the account.
 */
@Entity('dm_seat_evictions')
@Index('IDX_dm_seat_evictions_owed_departure', ['owedDeparture'], {
  where: '"owedDeparture" IS NOT NULL',
})
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

  /** The departure in progress (the generation that began it), or null when none is. */
  @Column({ type: 'integer', nullable: true })
  owedDeparture: number | null;

  /** When an eviction last rewrote the row (diagnostic only - nothing is decided on it). */
  @UpdateDateColumn()
  updatedAt: Date;
}
