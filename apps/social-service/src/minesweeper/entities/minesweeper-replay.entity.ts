import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { TimedMove } from '../minesweeper.timings';

/**
 * The timed move log of one verified win, kept for a moderator to replay (`replay` in the service).
 * One row per score and `ON DELETE CASCADE` from it (migration 175): removing a score, or erasing
 * the account that owns it, removes the replay with it.
 */
@Entity('minesweeper_replays')
export class MinesweeperReplay {
  @PrimaryColumn({ type: 'uuid' })
  scoreId!: string;

  /** Every dig and flag in order, `t` in ms from the first dig. */
  @Column({ type: 'jsonb' })
  moves!: TimedMove[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
