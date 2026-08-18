import { Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { AnnouncementService, type AnnouncementForClient } from './announcement.service';

/**
 * What a signed-in account is shown at the next app opening, and its dismissal.
 *
 * Separate from `PlatformAdminController` because these two routes are the only ones in the module
 * an ordinary member may call: an admin guard on the whole controller is easier to keep right than
 * an admin guard on all-but-two handlers.
 */
@Controller('users/announcement')
export class AnnouncementController {
  constructor(private readonly announcements: AnnouncementService) {}

  /**
   * The announcement this account has not yet seen, or `null`.
   *
   * `clientVersion` is the caller's own build. It is a query parameter rather than something the
   * server infers because nothing in the request carries it, and an unreadable or missing value
   * yields `null` rather than an error - the contract is "you have an announcement or you do not".
   */
  @UseGuards(NginxAuthGuard)
  @Get()
  get(
    @Headers('x-user-id') xUserId: string,
    @Query('clientVersion') clientVersion?: string
  ): Promise<AnnouncementForClient | null> {
    return this.announcements.getForUser(
      xUserId.trim().toLowerCase(),
      (clientVersion ?? '').trim()
    );
  }

  /**
   * Records that this account has seen it. Idempotent, and safe from any device.
   *
   * The id is taken from the path rather than assumed to be the active one, so a modal still open
   * when a new announcement is published dismisses the one that was actually read.
   */
  @UseGuards(NginxAuthGuard)
  @Post(':announcementId/seen')
  async markSeen(
    @Headers('x-user-id') xUserId: string,
    @Param('announcementId') announcementId: string
  ): Promise<{ success: true }> {
    await this.announcements.markSeen(xUserId.trim().toLowerCase(), announcementId);
    return { success: true };
  }
}
