import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
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
import { FormsModule } from '../forms/forms.module';
import { BookingFile } from './entities/booking-file.entity';
import { BookingFilesService } from './booking-files.service';
import { BookingPosterMedia } from './booking-poster-media';
import { BookingRetentionScheduler } from './booking-retention.scheduler';
import { BookingNotificationsService } from './booking-notifications.service';
import { BookingReminderScheduler } from './booking-reminder.scheduler';
import { PostsModule } from '../posts/posts.module';

/** Every table of the module (migrations 087 onwards), in parent-to-child order. */
export const BOOKING_ENTITIES = [
  BookingSpace,
  BookingResource,
  BookingAvailabilityRule,
  BookingAvailabilityException,
  BookingBlock,
  Booking,
  BookingParticipant,
  BookingFile,
];

/**
 * Bookings of rooms and slots (docs/wiki/bookings-chantier.md): the tables (WP-B1), slot
 * generation on demand (WP-B2, `BookingSlotsService`), the booker's API (WP-B3,
 * `BookingsController`), the organiser's (WP-B4, `BookingSpacesController`) and a booking's
 * signed `.ics` (WP-B5, `BookingCalendarController`); the file answers, the poster, the retention
 * purge and the export (WP-B6, `BookingFilesService`, `BookingPosterMedia`,
 * `BookingRetentionScheduler`); the notices and the reminder (WP-N, `BookingNotificationsService`,
 * `BookingReminderScheduler`, through `PostsModule`'s one notification pipeline).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(BOOKING_ENTITIES),
    HttpModule.register({ timeout: 30_000, maxRedirects: 0 }),
    AssociationsModule,
    PricingModule,
    UserTagModule,
    FormsModule,
    PostsModule,
  ],
  controllers: [BookingsController, BookingSpacesController, BookingCalendarController],
  providers: [
    BookingSlotsService,
    BookingsService,
    BookingSpacesService,
    BookingFilesService,
    BookingPosterMedia,
    BookingRetentionScheduler,
    BookingNotificationsService,
    BookingReminderScheduler,
  ],
  exports: [BookingSlotsService],
})
export class BookingsModule {}
