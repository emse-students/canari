import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { CloudflareSfuService } from '../services/cloudflare-sfu.service';
import { sanitizeQueryValue } from '../utils/sanitize';

/**
 * The Cloudflare Realtime proxy's routes (WP-GC3), under `/api/calls/sfu/` so nginx's existing
 * `/api/calls/` location authenticates them. Every route names the room; every route but `session`
 * names the caller's own Cloudflare session. The checks live in {@link CloudflareSfuService}.
 */
@Controller()
export class CloudflareSfuController {
  constructor(private readonly sfu: CloudflareSfuService) {}

  /** Opens the caller's session and claims its seat, with the room token `initiate`/`room-token` gave. */
  @UseGuards(HeaderAuthGuard)
  @Post('calls/sfu/session')
  @HttpCode(200)
  openSession(
    @Body() body: { roomId?: unknown; roomToken?: unknown },
    @Headers('x-user-id') userId?: string
  ) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    const roomId = sanitizeQueryValue(body?.roomId, 'roomId');
    if (typeof body?.roomToken !== 'string' || body.roomToken.length === 0) {
      throw new BadRequestException('roomToken is required');
    }
    return this.sfu.openSession(userId, roomId, body.roomToken);
  }

  /** Pushes the caller's tracks and/or pulls another participant's (`tracks/new`). */
  @UseGuards(HeaderAuthGuard)
  @Post('calls/sfu/tracks')
  @HttpCode(200)
  addTracks(
    @Body() body: { roomId?: unknown; sessionId?: unknown },
    @Headers('x-user-id') userId?: string
  ) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    return this.sfu.addTracks(
      userId,
      sanitizeQueryValue(body?.roomId, 'roomId'),
      sanitizeQueryValue(body?.sessionId, 'sessionId'),
      body
    );
  }

  /** Answers the offer a pull returned (`renegotiate`). */
  @UseGuards(HeaderAuthGuard)
  @Put('calls/sfu/renegotiate')
  renegotiate(
    @Body() body: { roomId?: unknown; sessionId?: unknown; sessionDescription?: unknown },
    @Headers('x-user-id') userId?: string
  ) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    return this.sfu.renegotiate(
      userId,
      sanitizeQueryValue(body?.roomId, 'roomId'),
      sanitizeQueryValue(body?.sessionId, 'sessionId'),
      body?.sessionDescription
    );
  }

  /** Closes tracks of the caller's own session (`tracks/close`). */
  @UseGuards(HeaderAuthGuard)
  @Put('calls/sfu/tracks/close')
  closeTracks(
    @Body() body: { roomId?: unknown; sessionId?: unknown },
    @Headers('x-user-id') userId?: string
  ) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    return this.sfu.closeTracks(
      userId,
      sanitizeQueryValue(body?.roomId, 'roomId'),
      sanitizeQueryValue(body?.sessionId, 'sessionId'),
      body
    );
  }

  /** The other seated participants and the tracks each pushed. */
  @UseGuards(HeaderAuthGuard)
  @Get('calls/sfu/roster')
  roster(@Query('roomId') roomId: string, @Headers('x-user-id') userId?: string) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    return this.sfu.roster(userId, sanitizeQueryValue(roomId, 'roomId'));
  }

  /** Gives the caller's seat back; answers how many participants are left. */
  @UseGuards(HeaderAuthGuard)
  @Post('calls/sfu/leave')
  @HttpCode(200)
  leave(
    @Body() body: { roomId?: unknown; sessionId?: unknown },
    @Headers('x-user-id') userId?: string
  ) {
    if (!userId) throw new BadRequestException('Missing X-User-Id header');
    return this.sfu.leave(
      userId,
      sanitizeQueryValue(body?.roomId, 'roomId'),
      sanitizeQueryValue(body?.sessionId, 'sessionId')
    );
  }
}
