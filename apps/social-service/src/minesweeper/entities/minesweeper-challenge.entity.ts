import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Lifecycle of a ranked Minesweeper attempt. */
export type MinesweeperChallengeStatus = 'open' | 'submitted' | 'rejected' | 'expired';

/**
 * Server-issued ranked challenge. The client never invents the seed: anti-cheat
 * regenerates the board from `(seed, first reveal)` and replays submitted moves.
 */
@Entity('minesweeper_challenges')
export class MinesweeperChallenge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** OIDC subject of the player. */
  @Index()
  @Column({ type: 'varchar', length: 255 })
  userId!: string;

  /** Opaque hex seed used by the shared mulberry32 generator. */
  @Column({ type: 'varchar', length: 64 })
  seed!: string;

  @Column({ type: 'int' })
  width!: number;

  @Column({ type: 'int' })
  height!: number;

  @Column({ type: 'int' })
  mineCount!: number;

  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: MinesweeperChallengeStatus;

  /**
   * The mine-placement generator the board is replayed with: part of the challenge, because the same
   * (seed, first click) makes a different board under each. 1 for a challenge issued before versions.
   */
  @Column({ type: 'smallint', default: 1 })
  generatorVersion!: number;
}
