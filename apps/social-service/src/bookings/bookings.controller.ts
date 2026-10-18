import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { BookingsService, SPACE_BOOKINGS_PAGE, type Actor } from './bookings.service';
import { CreateBlockDto, CreateBookingDto } from './dto/booking.dto';

/** The caller nginx authenticated. */
export const actorOf = (userId: string, globalAdmin: string | undefined): Actor => ({
  userId: userId.trim().toLowerCase(),
  isGlobalAdmin: globalAdmin === 'true',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `ids` filter of the organiser's list: absent is every booking; present, a comma-separated
 * list of at most one page of UUIDs, or a 400 `ids` - never a query on a malformed id.
 */
export function parseIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = raw.split(',').map((s) => s.trim().toLowerCase());
  if (ids.length > SPACE_BOOKINGS_PAGE || !ids.every((id) => UUID.test(id))) {
    throw new BadRequestException({ code: 'ids' });
  }
  return [...new Set(ids)];
}

/**
 * The bookings API (WP-B3, docs/wiki/bookings-chantier.md). Every route needs a signed-in account
 * (D6: no guest access). Ids are validated at the boundary, so a malformed one is a 400, never a
 * 500 from the query layer. The clock is read ONCE per request, here, and handed down.
 */
@Controller('bookings')
@UseGuards(NginxAuthGuard)
export class BookingsController {
  constructor(private readonly service: BookingsService) {}

  /** The actor's bookings, as holder or participant. */
  @Get('mine')
  mine(@Headers('x-user-id') userId: string, @Headers('x-global-admin') ga?: string) {
    return this.service.mine(actorOf(userId, ga));
  }

  /** The listed spaces the actor may book (D16, D31): the Reservations page. */
  @Get('spaces')
  listed(@Headers('x-user-id') userId: string, @Headers('x-global-admin') ga?: string) {
    return this.service.listedSpaces(actorOf(userId, ga));
  }

  /** The signed `.ics` path of one booking (D13), for its people and its organiser. */
  @Get(':bookingId/calendar-link')
  calendarLink(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.calendarLink(bookingId, actorOf(userId, ga));
  }

  /** A space and its resources, as a booker reads them. */
  @Get('spaces/:spaceId')
  space(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.getSpace(spaceId, actorOf(userId, ga));
  }

  /** The grid over local dates `from`..`to` (YYYY-MM-DD, both included, at most 62 days). */
  @Get('spaces/:spaceId/slots')
  slots(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.spaceSlots(spaceId, from, to, actorOf(userId, ga));
  }

  /**
   * Every booking of the space, answers included: the organiser's list. `ids` (comma-separated,
   * at most one page) narrows it to the bookings a D29 refusal named.
   */
  @Get('spaces/:spaceId/bookings')
  spaceBookings(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Headers('x-user-id') userId: string,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('limit', new DefaultValuePipe(SPACE_BOOKINGS_PAGE), ParseIntPipe) limit: number,
    @Query('ids') ids?: string,
    @Headers('x-global-admin') ga?: string
  ) {
    if (offset < 0) throw new BadRequestException({ code: 'offset' });
    return this.service.spaceBookings(spaceId, actorOf(userId, ga), offset, limit, parseIds(ids));
  }

  /** Books a range; an organiser may book on behalf of an account. */
  @Post('spaces/:spaceId/bookings')
  book(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateBookingDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.book(spaceId, dto, actorOf(userId, ga), Date.now());
  }

  /** Cancels a coming booking: its holder or the organiser, at any time before the start (D5). */
  @Post(':bookingId/cancel')
  cancel(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.cancel(bookingId, actorOf(userId, ga), Date.now());
  }

  /** A participant leaves a coming booking. */
  @Post(':bookingId/withdraw')
  withdraw(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.withdraw(bookingId, actorOf(userId, ga), Date.now());
  }

  /** "Indisponible" over a range of a resource: the organiser or the resource's linked account. */
  @Post('resources/:resourceId/blocks')
  addBlock(
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Body() dto: CreateBlockDto,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.addBlock(resourceId, dto, actorOf(userId, ga), Date.now());
  }

  /** Lifts a block that has not ended. */
  @Delete('blocks/:blockId')
  removeBlock(
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.removeBlock(blockId, actorOf(userId, ga), Date.now());
  }
}
