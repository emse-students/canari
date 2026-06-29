import {
  Controller,
  Delete,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { QueuedMessage } from '../entities/queued-message.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import {
  MessagingService,
  SendMessageBody,
  AckMessagesBody,
} from '../services/messaging.service';

/** MLS message send, commit validation, welcome delivery, history, and ACK. */
@Controller()
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @UseGuards(HeaderAuthGuard)
  @Post('mls/send')
  async sendMessage(@Body() body: SendMessageBody) {
    return this.messagingService.sendMessage(body);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/commit')
  async validateCommit(
    @Body() body: { groupId: string; deviceId: string; baseEpoch: number },
  ) {
    return this.messagingService.validateCommit(body);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/welcome')
  async sendWelcome(
    @Headers('x-user-id') authUserId: string | undefined,
    @Body()
    body: {
      targetDeviceId: string;
      targetUserId?: string;
      senderUserId?: string;
      welcomePayload: string;
      ratchetTreePayload?: string;
      groupId: string;
    },
  ) {
    return this.messagingService.sendWelcome(authUserId, body);
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/welcome-request/group/:groupId')
  /** Clears the pending welcome_request queue for a group after a successful reboot. */
  async clearPendingWelcomeRequests(@Param('groupId') groupId: string) {
    return this.messagingService.clearPendingWelcomeRequests(groupId);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/welcome-request')
  async notifyWelcomeRequest(
    @Body()
    body: {
      groupId: string;
      requesterUserId: string;
      requesterDeviceId: string;
    },
  ) {
    return this.messagingService.notifyWelcomeRequest(body);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/history/batch')
  async getHistoryBatch(
    @Body()
    body: { groups?: { groupId: string; after?: string; limit?: number }[] },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    return this.messagingService.getHistoryBatch(
      body?.groups ?? [],
      headerUserId,
      headerGlobalAdmin,
    );
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/history/:groupId')
  async getHistory(
    @Param('groupId') groupId: string,
    @Query('after') after?: string,
    @Query('limit') limitRaw?: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ): Promise<Record<string, unknown>[]> {
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    return this.messagingService.getHistory(
      groupId,
      after,
      headerUserId,
      headerGlobalAdmin,
      Number.isFinite(limit) ? limit : undefined,
    );
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/messages/:userId/:deviceId')
  async fetchMessages(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Query('limit') limitRaw?: string,
    @Query('after') after?: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ): Promise<QueuedMessage[]> {
    const limit = limitRaw ? parseInt(limitRaw, 10) : 500;
    return this.messagingService.fetchMessages(
      userId,
      deviceId,
      headerUserId,
      headerGlobalAdmin,
      Number.isFinite(limit) ? limit : 500,
      after,
    );
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/messages/ack')
  async acknowledgeMessages(
    @Body() body: AckMessagesBody,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    return this.messagingService.acknowledgeMessages(
      body,
      headerUserId,
      headerGlobalAdmin,
    );
  }

  /**
   * Notify the author of a message that someone reacted to it.
   * Fire-and-forget from the client - the server never sees MLS plaintext;
   * the client provides all required metadata.
   * Guard: no notification if the reactor is the same user as the message author
   * (cross-device own-action - the user already knows what they did).
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/notify-reaction')
  async notifyReaction(
    @Headers('x-user-id') callerId: string,
    @Body()
    body: {
      groupId: string;
      targetSenderId: string;
      emoji: string;
      messagePreview: string;
      actorName: string;
    },
  ): Promise<{ sent: number; failed: number }> {
    if (!callerId) throw new BadRequestException('x-user-id header required');

    // Never notify if actor == message author (cross-device own-reaction)
    if (!body.targetSenderId || callerId === body.targetSenderId) {
      return { sent: 0, failed: 0 };
    }

    const emoji = String(body.emoji ?? '').slice(0, 20);
    const preview = String(body.messagePreview ?? '').slice(0, 80);
    const actor = String(body.actorName ?? callerId).slice(0, 100);

    const notifBody = `${actor} reacted with ${emoji} to "${preview}"`;

    return this.messagingService.sendPushToUser(
      body.targetSenderId,
      'New reaction',
      notifBody,
      {
        type: 'social',
        deepLink: `fr.emse.canari://chat/${body.groupId ?? ''}`,
        groupId: body.groupId ?? '',
      },
    );
  }
}
