import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BookingResource } from './booking-resource.entity';

/**
 * Whole local days removed from a resource's typical week - a holiday, a closure (D11, migration
 * 087). Both ends are INCLUDED: `fromDate = toDate` closes one day. A range of instants that must
 * show as "Indisponible" is a `BookingBlock`, not this.
 */
@Entity('booking_availability_exceptions')
@Check('booking_availability_exceptions_order', `"fromDate" <= "toDate"`)
export class BookingAvailabilityException {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('booking_availability_exceptions_resource_idx')
  resourceId: string;

  @ManyToOne(() => BookingResource, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'resourceId',
    foreignKeyConstraintName: 'booking_availability_exceptions_resource_fk',
  })
  resource?: BookingResource;

  @Column({ type: 'date' })
  fromDate: string;

  @Column({ type: 'date' })
  toDate: string;
}
