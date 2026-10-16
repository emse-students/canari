import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Booking } from './booking.entity';
import { DELETED_ACCOUNT_ID } from '../deleted-account';

/**
 * A person of a booking other than its holder (D4, D34, migration 087).
 *
 * A withdrawal sets `withdrawnAt` and keeps the row, the history being frozen (D15). The name is a
 * snapshot taken when they were added. The key is a surrogate because a deleted account's `userId`
 * becomes `DELETED_ACCOUNT_ID` and two of them may share a booking; one row per (booking, account)
 * is a partial unique index that leaves those tombstones out.
 */
@Entity('booking_participants')
@Index('booking_participants_booking_user_uq', ['bookingId', 'userId'], {
  unique: true,
  where: `"userId" <> '${DELETED_ACCOUNT_ID}'`,
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
}
