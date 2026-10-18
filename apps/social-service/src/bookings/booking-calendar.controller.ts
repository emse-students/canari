import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BookingsService } from './bookings.service';

/**
 * THE ONE BOOKINGS ROUTE WITH NO SESSION (D13, WP-B5): a booking's `.ics`, fetched by a calendar
 * app that sends no identity. It is authorised by WHAT it asks - the `sig` that
 * `GET bookings/:id/calendar-link` handed to one of the booking's people - never by who asks; see
 * `booking-calendar.ts`. Its own controller, because every route of `BookingsController` carries
 * the session guard, and declared in `auth-request-coverage.test.mjs` as public by intent.
 */
@Controller('bookings')
export class BookingCalendarController {
  constructor(private readonly service: BookingsService) {}

  @Get(':bookingId/calendar.ics')
  async ics(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Query('sig') sig: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    const body = await this.service.calendarIcs(bookingId, sig);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // A link anyone holding it can open: never kept by a shared cache, so a cancellation is seen.
    res.setHeader('Cache-Control', 'private, no-store');
    return body;
  }
}
