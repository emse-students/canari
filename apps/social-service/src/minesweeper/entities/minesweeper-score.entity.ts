import {
  Column,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MinesweeperChallenge } from './minesweeper-challenge.entity';

/**
 * Verified personal-best (or attempt) time. `durationMs` is always measured on
 * the server (`submittedAt - startedAt`) — never taken from the client claim.
 */
@Entity('minesweeper_scores')
export class MinesweeperScore {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  challengeId!: string;

  @OneToOne(() => MinesweeperChallenge)
  @JoinColumn({ name: 'challengeId' })
  challenge?: MinesweeperChallenge;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  userId!: string;

  /** Server-measured clear time in milliseconds. */
  @Index()
  @Column({ type: 'int' })
  durationMs!: number;

  @Column({ type: 'int' })
  moveCount!: number;

  @Column({ type: 'timestamptz' })
  verifiedAt!: Date;
}
