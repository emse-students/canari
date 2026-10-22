import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A key-distribution eviction a removal owes (migration 109): written in the removal's transaction,
 * deleted once chat-delivery confirmed the eviction, retried by every later pass until then.
 *
 * Declared so that a schema built by `synchronize` (CI's boot job, a local stack, the integration
 * specs) has the table; PRODUCTION's comes from the migration. Read and written with raw SQL by
 * `ChannelService` (`oweEviction`, `settleOwedEvictions`).
 */
@Entity('distribution_evictions_owed')
export class DistributionEvictionOwed {
  /** `workspace` (a community's group) or `channel` (a private salon's). */
  @PrimaryColumn({ type: 'varchar', length: 16 })
  kind: 'workspace' | 'channel';

  @PrimaryColumn({ type: 'uuid' })
  scopeId: string;

  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** Why it is owed, carried into the eviction's log line. */
  @Column({ type: 'varchar', length: 64 })
  reason: string;

  /** Renewed when the row is owed again, so a pass deletes only the row it settled. */
  @Column({ type: 'uuid', default: () => 'gen_random_uuid()' })
  token: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
