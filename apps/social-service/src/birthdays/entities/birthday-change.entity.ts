import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * When a member last SET a birthday date (migration 148) - never the date itself. A date changes at
 * most once per 30 days (`BIRTHDAY_CHANGE_WINDOW_DAYS`), and a clear then a set counts as a change,
 * so this row outlives a clear; the notifier's hourly job deletes it once 30 days old, and the
 * account erasure deletes it at once. Written only by `BirthdaysService.setMine`.
 */
@Entity('birthday_changes')
export class BirthdayChange {
  /** The member. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  changedAt: Date;
}
