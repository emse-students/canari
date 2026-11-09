import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Two facts about a member's birthday that outlive a clear on purpose (migration 148) - never the
 * date itself: when a date was last SET (a new date at most once per 30 days,
 * `BIRTHDAY_CHANGE_WINDOW_DAYS`), and, after a clear that followed an announcement, the first day
 * a notice or a ring is possible again (`lastAnnouncedOn + 300`). The notifier's hourly job empties
 * each once it passes and deletes the empty row; the account erasure deletes it at once. Written
 * only by `BirthdaysService`.
 */
@Entity('birthday_changes')
export class BirthdayChange {
  /** The member. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;

  /** When a date was last set; `null` once its 30-day window passed. */
  @Column({ type: 'timestamptz', nullable: true })
  changedAt: Date | null;

  /** No notice nor ring before this Paris date (`lastAnnouncedOn + 300`, kept by a clear). */
  @Column({ type: 'date', nullable: true })
  noticeOpensOn: string | null;
}
