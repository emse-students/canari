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
 * A file uploaded for a FILE question of a booking space (migration 091, WP-B6) - the forms'
 * `FormFile` for a booking: the answer carries only this row's id.
 *
 * THE STATE IS THE ROW: `bookingId` null means "uploaded, not yet sent" (attachable for a day, then
 * purged with its row - and where a deleted booking's file lands, its foreign key setting it back to
 * NULL), set means "a booking's file" (purged `retentionDays` after the END of the booking's slot),
 * and `purgedAt` means the blob is gone. See `booking-files.service.ts`.
 *
 * The purge's predicates read only rows not yet purged: the partial index `booking_files_live_idx`.
 */
@Entity('booking_files')
@Index('booking_files_live_idx', ['createdAt'], { where: '"purgedAt" IS NULL' })
export class BookingFile {
  /** The media service's object id - the same string the answer stores. */
  @PrimaryColumn('uuid')
  id: string;

  /** No foreign key: a deleted space's files stay listed until the purge has taken their blobs. */
  @Column({ type: 'uuid' })
  @Index('booking_files_space_idx')
  spaceId: string;

  /** The question it was uploaded for; a booking may cite it under that question only. */
  @Column({ type: 'varchar', length: 64 })
  itemId: string;

  /** Who uploaded it: the booker, or the organiser booking on someone's behalf. */
  @Column({ type: 'varchar', length: 255 })
  uploaderId: string;

  /** Read from the bytes at upload (`detectFormFileType`), never from the client's declaration. */
  @Column({ type: 'varchar', length: 64 })
  contentType: string;

  /** The name the device gave it, cleaned for a `Content-Disposition` header. */
  @Column({ type: 'varchar', length: 255 })
  fileName: string;

  @Column({ type: 'int' })
  sizeBytes: number;

  @Column({ type: 'uuid', nullable: true })
  @Index('booking_files_booking_idx')
  bookingId: string | null;

  /**
   * Foreign key `booking_files_booking_fk`, ON DELETE SET NULL - the ONE relation of the module that
   * does not cascade: a deleted booking's file becomes an unsent upload, which the purge takes (blob,
   * then row); a cascade would delete the only record of a blob that still exists.
   */
  @ManyToOne(() => Booking, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'bookingId', foreignKeyConstraintName: 'booking_files_booking_fk' })
  booking?: Booking | null;

  /** Set once the media service said the blob is gone. */
  @Column({ type: 'timestamptz', nullable: true })
  purgedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
