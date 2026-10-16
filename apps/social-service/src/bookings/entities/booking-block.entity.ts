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
import { BookingResource } from './booking-resource.entity';

/**
 * "Indisponible": a half-open range `[startsAt, endsAt)` of a resource taken out by the organiser
 * or by the resource's linked account (D10, D20, migration 087).
 *
 * NO database constraint stops a block from overlapping a live booking: D29 refuses that in the
 * service (WP-B3), which must serialise a block and a booking of the same resource itself.
 */
@Entity('booking_blocks')
@Index('booking_blocks_resource_idx', ['resourceId', 'startsAt'])
@Check('booking_blocks_order', `"startsAt" < "endsAt"`)
export class BookingBlock {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  resourceId: string;

  @ManyToOne(() => BookingResource, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'resourceId', foreignKeyConstraintName: 'booking_blocks_resource_fk' })
  resource?: BookingResource;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** Whether bookers see the reason, or only "Indisponible". */
  @Column({ type: 'boolean', default: false })
  reasonVisible: boolean;

  @Column({ type: 'varchar', length: 255 })
  createdById: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
