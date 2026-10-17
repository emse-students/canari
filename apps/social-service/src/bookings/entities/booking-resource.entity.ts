import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BookingSpace } from './booking-space.entity';

/**
 * One bookable column of a space - the room, one alumni (D10, migration 087).
 *
 * The parent of everything time-shaped: its own availability rules, exceptions, blocks and
 * bookings hang off it, so a row can never name a resource of another space.
 */
@Entity('booking_resources')
export class BookingResource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('booking_resources_space_idx')
  spaceId: string;

  /** Foreign key `booking_resources_space_fk`: deleting a space deletes its resources (D27). */
  @ManyToOne(() => BookingSpace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'spaceId', foreignKeyConstraintName: 'booking_resources_space_fk' })
  space?: BookingSpace;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** The public free text: a sector, a remark. */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** The "after booking" text, returned only to a booking's people (D32). */
  @Column({ type: 'text', nullable: true })
  privateInfo: string | null;

  /** An account that sees this resource's bookings and may block itself; NULL = a plain label. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index('booking_resources_linked_user_idx')
  linkedUserId: string | null;

  /** Column order in the grid. */
  @Column({ type: 'int', default: 0 })
  position: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
