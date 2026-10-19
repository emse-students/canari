import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Live } from './live.entity';

/**
 * One viewer's reaction taps, summed by its client over at most a second (WP-L6, C7; migration 098).
 * The poll answers the SUMS of the bursts per 2 s `window`, never a burst - and never a tap. The row
 * goes with its live (C2).
 */
@Entity('live_reaction_bursts')
@Index('live_reaction_bursts_burst', ['liveId', 'userId', 'burstId'], { unique: true })
@Index('live_reaction_bursts_user_idx', ['userId', 'createdAt'])
@Check('live_reaction_bursts_taps', `taps > 0`)
export class LiveReactionBurst {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'live_reaction_bursts_pkey' })
  liveId: string;

  /** Foreign key `live_reaction_bursts_live_fk`: the bursts go with their live. */
  @ManyToOne(() => Live, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'liveId', foreignKeyConstraintName: 'live_reaction_bursts_live_fk' })
  live?: Live;

  /** From `lives.reactionSeq`, under the live's row lock (C4). */
  @PrimaryColumn({ type: 'integer', primaryKeyConstraintName: 'live_reaction_bursts_pkey' })
  seq: number;

  /** The tapping account - a 64-char hex user id, never a uuid. */
  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** The client's idempotence key (C5). */
  @Column({ type: 'uuid' })
  burstId: string;

  /** The 2 s step of the live the burst arrived in: floor((createdAt - startedAt) / 2 s). */
  @Column({ type: 'integer' })
  window: number;

  /** `{ like?: n, love?: n, ... }`, each 1..10, validated against `LIVE_REACTION_KINDS`. */
  @Column({ type: 'jsonb' })
  counts: Record<string, number>;

  /** The sum of `counts`, which the per-account tap rate reads (C6). */
  @Column({ type: 'integer' })
  taps: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
