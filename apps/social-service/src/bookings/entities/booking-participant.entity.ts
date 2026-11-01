import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Booking } from './booking.entity';
import { DELETED_ACCOUNT } from '../../internal/account-erasure';

/**
 * A person of a booking other than its holder (D4, D34, migration 087).
 *
 * A withdrawal sets `withdrawnAt` and keeps the row, the history being frozen (D15). The name is a
 * snapshot taken when they were added. The key is a surrogate because a deleted account's `userId`
 * becomes `DELETED_ACCOUNT` and two of them may share a booking; one row per (booking, account)
 * is a partial unique index that leaves those tombstones out.
 */
@Entity('booking_participants')
@Check(
  'booking_participants_reminder_range',
  `"reminderMinutes" IS NULL OR "reminderMinutes" BETWEEN 5 AND 10080`
)
// The reminder cron's scan (migration 115): only the rows still owed one.
@Index('booking_participants_reminder_due_idx', ['bookingId'], {
  where: `"reminderSentAt" IS NULL AND "reminderMinutes" IS NOT NULL AND "withdrawnAt" IS NULL`,
})
@Index('booking_participants_booking_user_uq', ['bookingId', 'userId'], {
  unique: true,
  where: `"userId" <> '${DELETED_ACCOUNT}'`,
})
export class BookingParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  bookingId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index('booking_participants_user_idx')
  userId: string;

  /** Foreign key `booking_participants_booking_fk`: a deleted booking takes its participants. */
  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bookingId', foreignKeyConstraintName: 'booking_participants_booking_fk' })
  booking?: Booking;

  @Column({ type: 'varchar', length: 255 })
  userName: string;

  @CreateDateColumn({ type: 'timestamptz' })
  addedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  withdrawnAt: Date | null;

  /**
   * The bookings reminder (WP-N, D53, migration 115): THIS person's delay before the slot, in
   * minutes (NULL = none), when it was chosen, and the CLAIM stamped before the reminder is sent.
   * `BookingReminderScheduler` is the only reader of the last two.
   */
  @Column({ type: 'int', nullable: true })
  reminderMinutes: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  reminderSetAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  reminderSentAt: Date | null;
}
