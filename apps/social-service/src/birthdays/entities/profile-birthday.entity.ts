import { Check, Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { ProfileFieldVisibility } from '../profile-field-visibility';

/**
 * A member's birthday (migration 148, owner 2026-11-08): the DAY and the MONTH, never the year, and
 * who may see it outside the day (`ProfileFieldVisibility`, FOLLOWERS by default). One row per member
 * who entered one; no row is "not entered", the state of every existing account.
 *
 * Read only through `BirthdaysService`, which applies the visibility rule in SQL
 * (`profileFieldVisibleToSql`) - never returned to a client as an entity.
 */
@Entity('profile_birthdays')
@Check(`month BETWEEN 1 AND 12`)
@Check(`day BETWEEN 1 AND 31`)
@Check(`visibility IN ('school', 'followers', 'nobody')`)
@Check(
  'CHK_profile_birthdays_calendar',
  `day <= CASE WHEN month = 2 THEN 29 WHEN month IN (4, 6, 9, 11) THEN 30 ELSE 31 END`
)
@Index('IDX_profile_birthdays_month_day', ['month', 'day'])
export class ProfileBirthday {
  /** The member. No foreign key: `users` is core-service's table; the account erasure deletes the row. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** 1..12. */
  @Column({ type: 'smallint' })
  month: number;

  /** 1..31, held to the month's length (29 for February). */
  @Column({ type: 'smallint' })
  day: number;

  @Column({ type: 'varchar', length: 16, default: 'followers' })
  visibility: ProfileFieldVisibility;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
