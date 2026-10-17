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
 * One line of a resource's availability, in the space's LOCAL wall time (D11, D25, migration 087).
 *
 * Exactly one of `weekday` (the typical week) and `onDate` (a ponctual day) is set. In a 'step'
 * space it is a window cut into steps; in a 'slots' space it IS one predefined slot (D3). Times are
 * `HH:MM[:SS]` strings as the `time` type returns them; a recurrent 18:00 stays 18:00 across a
 * daylight-saving change because nothing here is an instant.
 */
@Entity('booking_availability_rules')
@Check('booking_availability_rules_one_kind', `(weekday IS NULL) <> ("onDate" IS NULL)`)
@Check('booking_availability_rules_weekday', `weekday IS NULL OR weekday BETWEEN 1 AND 7`)
@Check('booking_availability_rules_order', `"startTime" < "endTime"`)
export class BookingAvailabilityRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('booking_availability_rules_resource_idx')
  resourceId: string;

  @ManyToOne(() => BookingResource, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'resourceId',
    foreignKeyConstraintName: 'booking_availability_rules_resource_fk',
  })
  resource?: BookingResource;

  /** ISO weekday, 1 = Monday .. 7 = Sunday; NULL for a dated line. */
  @Column({ type: 'smallint', nullable: true })
  weekday: number | null;

  /** A local calendar day (`YYYY-MM-DD`); NULL for a typical-week line. */
  @Column({ type: 'date', nullable: true })
  onDate: string | null;

  @Column({ type: 'time' })
  startTime: string;

  @Column({ type: 'time' })
  endTime: string;
}
