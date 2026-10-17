import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingAvailabilityRule } from './entities/booking-availability-rule.entity';
import { BookingAvailabilityException } from './entities/booking-availability-exception.entity';
import { BookingBlock } from './entities/booking-block.entity';
import { Booking } from './entities/booking.entity';
import { BookingParticipant } from './entities/booking-participant.entity';
import { BookingSlotsService } from './booking-slots.service';

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
 * Bookings of rooms and slots (docs/wiki/bookings-chantier.md): the tables of migration 087
 * (WP-B1) and slot generation on demand (WP-B2, `BookingSlotsService`). The API (WP-B3) adds its
 * controller here.
 */
@Module({
  imports: [TypeOrmModule.forFeature(BOOKING_ENTITIES)],
  providers: [BookingSlotsService],
  exports: [BookingSlotsService],
})
export class BookingsModule {}
