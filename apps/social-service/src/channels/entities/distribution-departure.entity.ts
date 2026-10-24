import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * How ONE departure from a key-distribution group ended - decided once, by whichever writes first
 * (migration 108).
 *
 * A departure is named by chat-delivery when it begins it (its first eviction answers
 * `groupId` + `departure`). `ChannelService.departDistributionGroups` writes `departed` in the very
 * transaction of the roster write, so the row exists exactly when the roster write committed.
 * chat-delivery's hourly drain asks about a departure whose second eviction never arrived
 * (`internal/distribution-groups/departure-outcome`), and that question writes `cancelled` if
 * nothing is there yet - the shared primary key then refuses the roster write's `departed`, which
 * rolls the departure back. So the answer the drain gets is FINAL: never "not yet", which an
 * entitlement read could not tell from a rejoin.
 *
 * Deleted with the account (`account-erasure.ts`).
 */
@Entity('distribution_departures')
export class DistributionDeparture {
  /** chat-delivery's `dm_groups.id` of the key-distribution group left. */
  @PrimaryColumn({ type: 'uuid' })
  groupId: string;

  /** The person leaving. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** chat-delivery's name for this departure: the eviction generation that began it. */
  @PrimaryColumn({ type: 'integer' })
  departure: number;

  /** `departed` (the roster write committed) or `cancelled` (decided before it could). */
  @Column({ type: 'varchar', length: 16 })
  outcome: 'departed' | 'cancelled';

  /** When the outcome was decided (diagnostic only - nothing is decided on it). */
  @CreateDateColumn()
  createdAt: Date;
}
