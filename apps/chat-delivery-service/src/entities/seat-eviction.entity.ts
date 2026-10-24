import { Entity, PrimaryColumn, Column, UpdateDateColumn, Index } from 'typeorm';

/**
 * The durable record that a person was cut off a group's seats - one row per `(groupId, userId)`,
 * rewritten by every eviction of that person (migration 036).
 *
 * **WHAT IT IS FOR: NAMING A KEY GROUP'S DEPARTURE.** A seat is written only against a claim no
 * eviction has overtaken, and what a claim compares is the GROUP's seat generation
 * (`Group.seatGeneration`), moved by every eviction of anyone - not this row, so nothing naming an
 * account has to outlive the account to refuse a claim it took before its erasure
 * (`utils/seat-eviction.ts`). This row refuses a claim only through `owedDeparture`. The mechanism:
 * `docs/wiki/protocols/channel-encryption.md` ("WP-21, and the gate it had nowhere to live").
 *
 * `owedDeparture` is a key group's departure IN PROGRESS, named by this row's generation for the
 * eviction that began it: social-service evicts before its roster write and again after it, and between the
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

  /** Incremented by every eviction of this person from this group; it names their departures. */
  @Column({ type: 'integer', default: 0 })
  generation: number;

  /** The departure in progress (the generation that began it), or null when none is. */
  @Column({ type: 'integer', nullable: true })
  owedDeparture: number | null;

  /** When an eviction last rewrote the row (diagnostic only - nothing is decided on it). */
  @UpdateDateColumn()
  updatedAt: Date;
}
