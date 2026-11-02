import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { AccountThrottlerGuard } from '../common/guards/account-throttler.guard';
import { HelpSeenService } from './help-seen.service';
import { isHelpId, type HelpId } from './help-ids';

/**
 * The refusal code of an id outside `HELP_IDS`: a client that sends one declared a help the server
 * does not know, which is a release mismatch to fix, never a value to store.
 */
export const HELP_ID_UNKNOWN = 'HELP_ID_UNKNOWN';

/**
 * Per account and per minute, for both routes together. An honest client reads once per app
 * opening and writes once per help it closes, and there are a handful of helps in all; thirty a
 * minute is a bound no member meets and the most a script could make the table do.
 */
export const HELP_SEEN_LIMIT_PER_MINUTE = 30;

/**
 * Which first-time helps this account has seen, and recording one (docs/wiki/frontend/guided-help.md).
 *
 * Under `users/me/...` for the reason `AnnouncementController` gives: a third segment cannot be
 * captured by the users catch-all `users/:id`, whatever the module order.
 */
@Controller('users/me/help-seen')
export class HelpSeenController {
  private readonly logger = new Logger(HelpSeenController.name);

  constructor(private readonly helps: HelpSeenService) {}

  /** The seen set, always as an envelope so "none" is a statement and not an empty body. */
  @Get()
  @UseGuards(NginxAuthGuard, AccountThrottlerGuard)
  @Throttle({ default: { limit: HELP_SEEN_LIMIT_PER_MINUTE, ttl: 60_000 } })
  async list(@Headers('x-user-id') xUserId: string): Promise<{ seen: HelpId[] }> {
    return { seen: await this.helps.seenBy(xUserId.trim().toLowerCase()) };
  }

  /**
   * Records one help as seen. Idempotent: the same id again answers the same 200 and writes nothing.
   * An id outside the allowlist is a 400 carrying {@link HELP_ID_UNKNOWN}, and nothing is written.
   */
  @Post(':helpId')
  @HttpCode(200)
  @UseGuards(NginxAuthGuard, AccountThrottlerGuard)
  @Throttle({ default: { limit: HELP_SEEN_LIMIT_PER_MINUTE, ttl: 60_000 } })
  async markSeen(
    @Headers('x-user-id') xUserId: string,
    @Param('helpId') helpId: string
  ): Promise<{ success: true }> {
    if (!isHelpId(helpId)) {
      // The id is not echoed whole: it is caller input, and the allowlist is what it failed.
      this.logger.warn(`[HELP_SEEN] refused an id outside HELP_IDS (${helpId.length} chars)`);
      throw new BadRequestException({ code: HELP_ID_UNKNOWN, message: 'Unknown help id' });
    }
    await this.helps.markSeen(xUserId.trim().toLowerCase(), helpId);
    return { success: true };
  }
}
