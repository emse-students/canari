import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingAvailabilityRule } from './entities/booking-availability-rule.entity';
import { BookingAvailabilityException } from './entities/booking-availability-exception.entity';
import { BookingBlock } from './entities/booking-block.entity';
import { Booking } from './entities/booking.entity';
import { BookingParticipant } from './entities/booking-participant.entity';

/** Every table of the module (migration 087), in parent-to-child order. */
export const BOOKING_ENTITIES = [
  BookingSpace,
  BookingResource,
  BookingAvailabilityRule,
  BookingAvailabilityException,
  BookingBlock,
  Booking,
  BookingParticipant,
];

/**
 * Bookings of rooms and slots (docs/wiki/bookings-chantier.md). WP-B1 is the data model ONLY: the
 * entities are registered so `synchronize` builds them in development; slot generation (WP-B2) and
 * the API (WP-B3) add their providers and controllers here.
 */
@Module({
  imports: [TypeOrmModule.forFeature(BOOKING_ENTITIES)],
})
export class BookingsModule {}
