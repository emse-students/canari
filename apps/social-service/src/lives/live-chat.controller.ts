import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AssociationsService } from '../associations/associations.service';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { LiveEnabledGuard } from './live-enabled.guard';
import { LiveChatService } from './live-chat.service';
import { callerOf } from './lives.controller';
import { LivesService } from './lives.service';

/**
 * The live chat's WRITES (WP-L6; docs/wiki/services/lives.md "Live chat and floating reactions").
 * The READ is the manifest poll's `chat` block (`LivesController.manifest`, C3): one request a tick.
 *
 * Behind the same two guards as every live route, in the same order: the switch, then an account.
 * A message and a burst are refused exactly as the key is (`LivesService.mayWatch`: absent, not in the
 * audience or blocked is 404, ended 410, removed 403) before the chat service takes the row lock.
 */
@Controller('lives')
@UseGuards(LiveEnabledGuard, NginxAuthGuard)
export class LiveChatController {
  constructor(
    private readonly lives: LivesService,
    private readonly chat: LiveChatService,
    private readonly associations: AssociationsService
  ) {}

  /** Posts a message: `{ clientId: <uuid>, sealed: <base64 of iv + ciphertext + tag> }`. */
  @Post(':id/messages')
  async post(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Body() body: { clientId?: unknown; sealed?: unknown }
  ) {
    const caller = callerOf(userId);
    await this.lives.mayWatch(caller, id);
    return this.chat.post(caller, id, body ?? {});
  }

  /** Records a reaction burst: `{ burstId: <uuid>, counts: { like?: n, ... } }`. */
  @Post(':id/reactions')
  async react(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Body() body: { burstId?: unknown; counts?: unknown }
  ) {
    const caller = callerOf(userId);
    await this.lives.mayWatch(caller, id);
    return this.chat.react(caller, id, body ?? {});
  }

  /**
   * Hides a message, by the live's broadcaster or STAFF - D6, C14. Staff is `isContentModerator`
   * (a platform admin, or a BDE member holding `MODERATE`): the ONE predicate of the posts'
   * moderation controls, reused rather than restated. No watch check: the broadcaster is the live's
   * own, and staff moderate what they may not watch.
   */
  @Post(':id/messages/:messageId/hide')
  @HttpCode(200)
  async hide(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') globalAdmin: string | undefined
  ) {
    const caller = callerOf(userId);
    const staff = await this.associations.isContentModerator(caller, {
      isGlobalAdmin: globalAdmin === 'true',
    });
    return this.chat.hide(caller, staff, id, messageId);
  }
}
