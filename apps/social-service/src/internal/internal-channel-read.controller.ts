import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import { ChannelService } from '../channels/channel.service';
import { assertInternalSecret } from './internal-secret.util';

interface ChannelReadBody {
  /** Whose read mark moves. chat-delivery has proven the caller holds this account's push secret. */
  userId: string;
  /** The newest message the reader acknowledged: its server `createdAt`, epoch ms. */
  at: number;
}

/**
 * "Mark as read" on a SALON notification, from a phone whose app is shut (Android quick action).
 *
 * Internal-only, like every route in this module. The caller is chat-delivery's PushSecret route
 * (`POST /api/mls/push/channel-read`), which is the only place that can prove a request comes from a
 * device of `userId`: a shut app has no session, so the public `/channels/:id/read-mark` (which
 * trusts the gateway's `x-user-id`) cannot be reached. The membership check stays HERE, inside
 * {@link ChannelService.advanceChannelReadMark}, so a stolen push secret still cannot move a mark in
 * a salon its owner cannot read.
 *
 * A salon is server-authoritative, so unlike a DM (a watermark frame over MLS) this is TWO calls to
 * the same service the app itself makes when it reads a salon: raise the read receipt, then fan the
 * silent `channel_read` out so the user's OTHER devices clear their banner. Both or neither is not
 * required: the receipt is the durable fact, the fan-out a courtesy that logs its own failure.
 */
@Controller('internal/channels')
export class InternalChannelReadController {
  private readonly logger = new Logger(InternalChannelReadController.name);

  constructor(private readonly channels: ChannelService) {}

  @Post(':channelId/read')
  @HttpCode(200)
  async read(
    @Headers('x-internal-secret') secret: string | undefined,
    @Param('channelId') channelId: string,
    @Body() body: ChannelReadBody
  ): Promise<{ at: number | null }> {
    assertInternalSecret(secret);
    const userId = String(body?.userId ?? '')
      .trim()
      .toLowerCase();
    if (!userId || !Number.isSafeInteger(body?.at) || body.at <= 0) {
      this.logger.warn(`[CHANNEL_READ_PUSH] refused: malformed body channel=${channelId}`);
      throw new BadRequestException('userId and a positive integer at are required');
    }
    // `at` is the notification's own message instant, which for a salon IS the row's server
    // `createdAt`: passed twice so the mark takes it whole and the newest-message bound still caps it.
    const moved = await this.channels.advanceChannelReadMark(channelId, userId, body.at, body.at);
    try {
      await this.channels.markChannelRead(channelId, userId);
    } catch (e) {
      // The receipt above is the durable fact; a failed fan-out only leaves a sibling's banner up.
      this.logger.warn(
        `[CHANNEL_READ_PUSH] fan-out failed user=${userId.slice(0, 8)} channel=${channelId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    this.logger.log(
      `[CHANNEL_READ_PUSH] user=${userId.slice(0, 8)} channel=${channelId.slice(0, 8)} moved=${moved !== null}`
    );
    return { at: moved?.at ?? null };
  }
}
