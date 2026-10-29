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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { contentDisposition } from '../common/content-disposition';
import { FORM_FILE_MAX_BYTES, type UploadedFormFile } from '../forms/form-files.service';
import { parseBookingExportLabels } from './booking-export';
import { BookingsService, SPACE_BOOKINGS_PAGE, type Actor } from './bookings.service';
import { CreateBlockDto, CreateBookingDto, ZONED_INSTANT } from './dto/booking.dto';

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
 * The `from` filter of the organiser list (WP-R5): absent is the whole history; present, an
 * instant that names its zone (`Z` or an offset - without one `Date.parse` would read it in the
 * SERVER's zone), or a 400 `from`.
 */
export function parseFrom(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = ZONED_INSTANT.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isNaN(ms)) throw new BadRequestException({ code: 'from' });
  return ms;
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
   * at most one page) narrows it to the bookings a D29 refusal named; `from` (an instant) to the
   * live ones ending after it - the dashboard's "coming" list (WP-R5).
   */
  @Get('spaces/:spaceId/bookings')
  spaceBookings(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Headers('x-user-id') userId: string,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('limit', new DefaultValuePipe(SPACE_BOOKINGS_PAGE), ParseIntPipe) limit: number,
    @Query('ids') ids?: string,
    @Query('from') from?: string,
    @Headers('x-global-admin') ga?: string
  ) {
    if (offset < 0) throw new BadRequestException({ code: 'offset' });
    return this.service.spaceBookings(
      spaceId,
      actorOf(userId, ga),
      offset,
      limit,
      parseIds(ids),
      parseFrom(from)
    );
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

  /**
   * Uploads the file of one FILE question (`itemId` in the multipart body) before the booking is
   * sent (D7, WP-B6). The interceptor's ceiling is one byte above the cap so the service, not
   * Multer, says what the cap is. Returns `{ fileId, fileName, sizeBytes, contentType }`.
   */
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: FORM_FILE_MAX_BYTES + 1 } }))
  @Post('spaces/:spaceId/files')
  uploadFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('itemId') itemId: string | undefined,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ): Promise<UploadedFormFile> {
    if (!file) throw new BadRequestException({ code: 'file-empty' });
    return this.service.uploadFile(spaceId, itemId, file, actorOf(userId, ga));
  }

  /**
   * Streams one booking's file to its ORGANISER - the only reader it has. Its own type and name,
   * `attachment` so a browser saves it, `nosniff` so the type read from the bytes is the one used.
   */
  @Get(':bookingId/files/:fileId')
  async downloadFile(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Res() res: Response,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    const { data, contentType, fileName } = await this.service.downloadFile(
      bookingId,
      fileId,
      actorOf(userId, ga)
    );
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition(fileName, fileId.slice(0, 8)),
      'Content-Length': data.byteLength,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store, private',
    });
    res.send(data);
  }

  /**
   * The XLSX of a space's bookings (D24), for its organiser. `labels` is the JSON of every word the
   * file is written with, from the client (`parseBookingExportLabels`): refused when one is missing.
   */
  @Get('spaces/:spaceId/export')
  async export(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Res() res: Response,
    @Headers('x-user-id') userId: string,
    @Query('labels') rawLabels?: string,
    @Headers('x-global-admin') ga?: string
  ) {
    const { buffer, name } = await this.service.exportBookings(
      spaceId,
      parseBookingExportLabels(rawLabels),
      actorOf(userId, ga)
    );
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': contentDisposition(`${name}.xlsx`, 'export'),
      'Content-Length': buffer.byteLength,
      'Cache-Control': 'no-store, private',
      // A workbook is never rendered as anything else (review of #2045).
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(Buffer.from(buffer));
  }
}
