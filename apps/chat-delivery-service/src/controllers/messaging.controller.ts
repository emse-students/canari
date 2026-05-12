import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Headers,
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
  @Post('mls/reinvite-request')
  async notifyReinviteRequest(
    @Body()
    body: {
      groupId: string;
      requesterUserId: string;
      requesterDeviceId: string;
    },
  ) {
    return this.messagingService.notifyReinviteRequest(body);
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/history/:groupId')
  async getHistory(
    @Param('groupId') groupId: string,
    @Query('after') after?: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ): Promise<Record<string, unknown>[]> {
    return this.messagingService.getHistory(
      groupId,
      after,
      headerUserId,
      headerGlobalAdmin,
    );
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/messages/:userId/:deviceId')
  async fetchMessages(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ): Promise<QueuedMessage[]> {
    return this.messagingService.fetchMessages(
      userId,
      deviceId,
      headerUserId,
      headerGlobalAdmin,
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
}
