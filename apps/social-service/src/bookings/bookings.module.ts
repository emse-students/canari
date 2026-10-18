import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssociationsModule } from '../associations/associations.module';
import { PricingModule } from '../pricing/pricing.module';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingAvailabilityRule } from './entities/booking-availability-rule.entity';
import { BookingAvailabilityException } from './entities/booking-availability-exception.entity';
import { BookingBlock } from './entities/booking-block.entity';
import { Booking } from './entities/booking.entity';
import { BookingParticipant } from './entities/booking-participant.entity';
import { BookingSlotsService } from './booking-slots.service';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { BookingSpacesService } from './booking-spaces.service';
import { BookingSpacesController } from './booking-spaces.controller';
import { BookingCalendarController } from './booking-calendar.controller';
import { UserTagModule } from '../users/user-tag.module';

/** Every table of the module (migrations 087 onwards), in parent-to-child order. */
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
 * Bookings of rooms and slots (docs/wiki/bookings-chantier.md): the tables (WP-B1), slot
 * generation on demand (WP-B2, `BookingSlotsService`), the booker's API (WP-B3,
 * `BookingsController`), the organiser's (WP-B4, `BookingSpacesController`) and a booking's
 * signed `.ics` (WP-B5, `BookingCalendarController`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(BOOKING_ENTITIES),
    AssociationsModule,
    PricingModule,
    UserTagModule,
  ],
  controllers: [BookingsController, BookingSpacesController, BookingCalendarController],
  providers: [BookingSlotsService, BookingsService, BookingSpacesService],
  exports: [BookingSlotsService],
})
export class BookingsModule {}
