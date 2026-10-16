import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Booking } from './booking.entity';

/**
 * A person of a booking other than its holder (D4, D34, migration 087).
 *
 * A withdrawal sets `withdrawnAt` and keeps the row, the history being frozen (D15). The name is a
 * snapshot taken when they were added.
 */
@Entity('booking_participants')
export class BookingParticipant {
  @PrimaryColumn('uuid')
  bookingId: string;

  @PrimaryColumn({ type: 'varchar', length: 255 })
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
