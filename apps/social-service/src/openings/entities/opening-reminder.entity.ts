import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { OpeningKind, OpeningOrigin } from '../opening-reminders';

/**
 * One person to tell that one form, booking space or event opens (migration 151, engagement WP-4,
 * decision 5d, L9). Replaces `form_reminders` (copied by the held migration 152).
 *
 * ONE ROW PER (kind, target, person): the unique key is what makes "one notification, never two" a
 * constraint - a follower who also asked has one row, so one claim, so one push. Written by
 * `openings/opening-reminders.ts` (the ask, the followers at publication, a moved opening) and
 * claimed by `FormReminderScheduler`; the stamps ARE the claims.
 */
@Entity('opening_reminders')
@Unique('UQ_opening_reminders_target_user', ['kind', 'targetId', 'userId'])
@Check(`kind IN ('form', 'booking', 'event')`)
@Check(`origin IN ('asked', 'followed')`)
@Index('IDX_opening_reminders_due', ['opensAt'], { where: 'NOT "notifiedOnOpen"' })
@Index('IDX_opening_reminders_user', ['userId'])
export class OpeningReminder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  kind: OpeningKind;

  /** The form, the booking space or the calendar event. No foreign key: one column names three tables. */
  @Column({ type: 'uuid' })
  targetId: string;

  @Column({ type: 'varchar', length: 255 })
  userId: string;

  /** When the target opens; `now()` for a target open at once (claimed at the next tick). */
  @Column({ type: 'timestamptz' })
  opensAt: Date;

  /** 'asked' ("Me prévenir") or 'followed' (written at publication for a follower). */
  @Column({ type: 'varchar', length: 16 })
  origin: OpeningOrigin;

  /** The five-minute heads-up was claimed - or is not owed: a follower's row is written true. */
  @Column({ default: false })
  notified5min: boolean;

  /** The opening was claimed. */
  @Column({ default: false })
  notifiedOnOpen: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
