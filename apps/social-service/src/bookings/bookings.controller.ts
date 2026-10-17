import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { BookingsService, type Actor } from './bookings.service';
import { CreateBlockDto, CreateBookingDto } from './dto/booking.dto';

/** The caller nginx authenticated. */
const actorOf = (userId: string, globalAdmin: string | undefined): Actor => ({
  userId: userId.trim().toLowerCase(),
  isGlobalAdmin: globalAdmin === 'true',
});

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

  /** Every booking of the space, answers included: the organiser's list. */
  @Get('spaces/:spaceId/bookings')
  spaceBookings(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.spaceBookings(spaceId, actorOf(userId, ga));
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

  /** Cancels a coming booking: its holder (within the delay) or the organiser. */
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
