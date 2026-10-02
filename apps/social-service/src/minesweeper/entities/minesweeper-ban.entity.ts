import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A user banned from the RANKED minesweeper. The row is the whole ban: reads ask whether one exists
 * for a user, so deleting it lifts the ban and restores that user's scores untouched (nothing is
 * deleted when someone is banned).
 */
@Entity('minesweeper_bans')
export class MinesweeperBan {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId!: string;

  /** Why, in the moderator's words. Optional: a ban is not blocked on writing one. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;

  /** The global admin who banned them. */
  @Column({ type: 'varchar', length: 255 })
  bannedBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  bannedAt!: Date;
}
