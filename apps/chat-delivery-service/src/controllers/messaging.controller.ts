import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { QueuedMessage } from '../entities/queued-message.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService, SendMessageBody, AckMessagesBody } from '../services/messaging.service';

/** MLS message send, commit validation, welcome delivery, history, and ACK. */
@Controller()
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @UseGuards(HeaderAuthGuard)
  @Post('mls/send')
  async sendMessage(@Body() body: SendMessageBody, @Headers('x-user-id') authUserId?: string) {
    return this.messagingService.sendMessage(body, authUserId);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/commit')
  async validateCommit(
    @Body()
    body: {
      groupId: string;
      deviceId: string;
      baseEpoch: number;
      proto?: string;
      senderId?: string;
      excludeDeviceIds?: string[];
      groupInfo?: string;
    }
  ) {
    return this.messagingService.validateCommit(body);
  }

  /**
   * Rung-1 replay: ordered commits with `baseEpoch >= sinceEpoch` so a device that fell behind
   * catches up without dropping its state. Membership-gated in the service.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/commits/:groupId')
  async getCommitsSince(
    @Headers('x-user-id') authUserId: string | undefined,
    @Param('groupId') groupId: string,
    @Query('sinceEpoch') sinceEpochRaw?: string
  ) {
    const sinceEpoch = Number.parseInt(sinceEpochRaw ?? '0', 10);
    if (!Number.isFinite(sinceEpoch) || sinceEpoch < 0) {
      throw new BadRequestException('sinceEpoch must be a non-negative integer');
    }
    if (!authUserId) {
      throw new BadRequestException('missing x-user-id');
    }
    return this.messagingService.getCommitsSince(groupId, sinceEpoch, authUserId);
  }

  /**
   * External-join base (Phase 4): the latest GroupInfo for a group, so an authorized member lacking
   * MLS state can build an external commit to (re)join. Membership-gated in the service.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/group-info/:groupId')
  async getGroupInfo(
    @Headers('x-user-id') authUserId: string | undefined,
    @Param('groupId') groupId: string
  ) {
    if (!authUserId) {
      throw new BadRequestException('missing x-user-id');
    }
    return this.messagingService.getGroupInfo(groupId, authUserId);
  }

  /**
   * Refreshes the stored GroupInfo for a group (the committer calls this after each accepted commit;
   * a new group's first member-add is itself a commit). Membership-gated; monotonic (a lower
   * baseEpoch is ignored).
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/group-info/:groupId')
  async storeGroupInfo(
    @Headers('x-user-id') authUserId: string | undefined,
    @Param('groupId') groupId: string,
    @Body() body: { groupInfo: string; baseEpoch: number }
  ) {
    if (!authUserId) {
      throw new BadRequestException('missing x-user-id');
    }
    if (typeof body?.groupInfo !== 'string' || !Number.isFinite(body?.baseEpoch)) {
      throw new BadRequestException('groupInfo (base64) and baseEpoch are required');
    }
    return this.messagingService.storeGroupInfo(
      groupId,
      authUserId,
      body.groupInfo,
      body.baseEpoch
    );
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
    }
  ) {
    return this.messagingService.sendWelcome(authUserId, body);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/welcome-request')
  async notifyWelcomeRequest(
    @Headers('x-user-id') authUserId: string | undefined,
    @Body()
    body: { groupId: string; requesterUserId: string; requesterDeviceId: string }
  ) {
    return this.messagingService.notifyWelcomeRequest(authUserId, body);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/history-request')
  async notifyHistoryRequest(
    @Headers('x-user-id') authUserId: string | undefined,
    @Body()
    body: {
      groupId: string;
      requesterUserId: string;
      requesterDeviceId: string;
      /** Member keys (`userId:deviceId`) already heard from - see `NotifyHistoryRequestBody`. */
      exclude?: string[];
    }
  ) {
    return this.messagingService.notifyHistoryRequest(authUserId, body);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/history/batch')
  async getHistoryBatch(
    @Body()
    body: { groups?: { groupId: string; after?: string; limit?: number; until?: string }[] },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    return this.messagingService.getHistoryBatch(
      body?.groups ?? [],
      headerUserId,
      headerGlobalAdmin
    );
  }

  /**
   * One history page. The body stays a bare array - the shape every deployed client already parses -
   * and the stream head travels in `X-History-Head`, which an older client simply ignores.
   *
   * The head is the upper bound the caller passes back as `until` for the rest of its walk, so a
   * replay never reads rows appended while it was running: those belong to the delivery queue.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/history/:groupId')
  async getHistory(
    @Param('groupId') groupId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('after') after?: string,
    @Query('limit') limitRaw?: string,
    @Query('until') until?: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<Record<string, unknown>[]> {
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const { rows, head } = await this.messagingService.getHistory(
      groupId,
      after,
      headerUserId,
      headerGlobalAdmin,
      Number.isFinite(limit) ? limit : undefined,
      until
    );
    if (head) res.setHeader('X-History-Head', head);
    return rows;
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/messages/:userId/:deviceId')
  async fetchMessages(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Query('limit') limitRaw?: string,
    @Query('after') after?: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<QueuedMessage[]> {
    const limit = limitRaw ? parseInt(limitRaw, 10) : 500;
    return this.messagingService.fetchMessages(
      userId,
      deviceId,
      headerUserId,
      headerGlobalAdmin,
      Number.isFinite(limit) ? limit : 500,
      after
    );
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/messages/ack')
  async acknowledgeMessages(
    @Body() body: AckMessagesBody,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ) {
    return this.messagingService.acknowledgeMessages(body, headerUserId, headerGlobalAdmin);
  }

  /**
   * Notifies the author of a message that someone reacted to it.
   *
   * NOTHING OF THE MESSAGE ITSELF CROSSES THIS ENDPOINT, and that is the point of its shape.
   * It used to take a `messagePreview` - 80 characters of the DECRYPTED message, computed by the
   * reacting client - and compose `<actor> a réagi <emoji> à « <preview> »` from it. That sentence
   * then travelled in the FCM data map AND in the APNs `alert.body`, so plaintext from an
   * end-to-end encrypted conversation reached this server, Google and Apple, on every reaction.
   * The docstring above it asserted the opposite ("the server never sees MLS plaintext") three
   * lines before the field that broke it. Nothing logged it, so it was in transit only - which is
   * not a defence, it is the extent of the damage.
   *
   * The recipient is the message's AUTHOR, so the device already holds the message: it needs an
   * id, not a copy. The push therefore carries `messageId` and the device renders the reaction
   * against its own copy, in its own language.
   *
   * WHY THE WIRE TYPE IS STILL `social`. `minClientVersion` is 0.13.0 and the store rollout has
   * not reached devices, so clients that predate this change are receiving these pushes right now.
   * An unknown `type` falls through their dispatch chain into the MLS decrypt ladder - noise on
   * every old phone, for a push with no ciphertext in it. The type stays, `reaction: 'true'`
   * discriminates, and `body` carries a GENERIC sentence with no message content: an old client
   * renders it exactly as it renders one today minus the preview, and a new one ignores it.
   * See `docs/wiki/legacy-compatibility.md` for when the generic body may be dropped.
   *
   * Guard: no notification if the reactor is the message author (cross-device own-action - the
   * user already knows what they did).
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
      /** The reacted-to message, so the device can find its own copy. Never its content. */
      messageId?: string;
      actorName: string;
    }
  ): Promise<{ sent: number; failed: number }> {
    if (!callerId) throw new BadRequestException('x-user-id header required');

    // Never notify if actor == message author (cross-device own-reaction)
    if (!body.targetSenderId || callerId === body.targetSenderId) {
      return { sent: 0, failed: 0 };
    }

    const emoji = String(body.emoji ?? '').slice(0, 20);
    const actor = String(body.actorName ?? callerId).slice(0, 100);
    const groupId = String(body.groupId ?? '');

    // Legacy body only - carries the emoji and the actor, never the message. Clients that
    // understand `reaction` compose their own from `strings.xml` / `Localizable.strings`.
    const legacyBody = `${actor} a réagi ${emoji} à votre message`;

    return this.messagingService.sendPushToUser(body.targetSenderId, actor, legacyBody, {
      type: 'social',
      reaction: 'true',
      deepLink: `fr.emse.canari://chat/${groupId}`,
      groupId,
      messageId: String(body.messageId ?? ''),
      emoji,
      // The ACTOR, so the device can fetch their avatar - the message path needs it and the
      // social path never carried one.
      senderId: callerId,
    });
  }
}
