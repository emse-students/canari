import { Check, Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One reader's REDUCTION of what one account pushes them (migration 142, engagement WP-3).
 *
 * The absent row is the default - posts and lives, set by following (decision 10) - so only the two
 * reductions are stored: `lives` (posts reach the bell but are not pushed) and `none` (nothing of
 * that account is pushed). A follow that comes into being deletes the row (L3). Read only by
 * `PostNotificationsService` when it decides whom to push, and by the reader's own bell routes; the
 * followed account never learns it.
 */
@Entity('account_bells')
@Check(`"targetKind" IN ('user', 'association')`)
@Check(`level IN ('lives', 'none')`)
@Index('IDX_account_bells_target', ['targetKind', 'targetId', 'userId'])
export class AccountBell {
  /** The reader who chose. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  @PrimaryColumn({ type: 'varchar', length: 16 })
  targetKind: 'user' | 'association';

  /** A user id, or an association uuid as text. No foreign key: one column names both kinds. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  targetId: string;

  @Column({ type: 'varchar', length: 8 })
  level: 'lives' | 'none';

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
