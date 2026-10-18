import { CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Live } from './live.entity';

/**
 * A viewer the broadcaster removed from one live (L6, Q4; migration 091). The server refuses that
 * account the live's key, its manifest and its listing for as long as the live lasts; the row goes
 * with the live.
 */
@Entity('live_removed_viewers')
export class LiveRemovedViewer {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'live_removed_viewers_pkey' })
  liveId: string;

  /** The removed account - a 64-char hex user id, never a uuid. */
  @PrimaryColumn({
    type: 'varchar',
    length: 255,
    primaryKeyConstraintName: 'live_removed_viewers_pkey',
  })
  viewerId: string;

  /** Foreign key `live_removed_viewers_live_fk`: the list goes with its live. */
  @ManyToOne(() => Live, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'liveId', foreignKeyConstraintName: 'live_removed_viewers_live_fk' })
  live?: Live;

  @CreateDateColumn({ type: 'timestamptz' })
  removedAt: Date;
}
