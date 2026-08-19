import { Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { AnnouncementService, type AnnouncementForClient } from './announcement.service';

/**
 * What a signed-in account is shown at the next app opening, and its dismissal.
 *
 * Separate from `PlatformAdminController` because these two routes are the only ones in the module
 * an ordinary member may call: an admin guard on the whole controller is easier to keep right than
 * an admin guard on all-but-two handlers.
 *
 * THE PATH CARRIES `me` BECAUSE `users/announcement` COULD NOT BE REACHED, and that is not a style
 * choice. Express resolves in REGISTRATION order, and registration order is the module graph:
 * `UsersModule` is imported first, so `{/api/users/:id, GET}` was mapped before this controller's
 * route and captured `/api/users/announcement` with `id = "announcement"`. The users service then
 * answered 404 for an account that does not exist. Measured on production 2026-08-19, off the
 * service's own `RouterExplorer` lines - the feature had never once been reached since it shipped.
 *
 * Reordering the imports would also have worked and is the wrong fix: it makes correctness depend on
 * a list nobody reads, and the next module added to `AppModule` breaks it silently. A THIRD segment
 * cannot collide with a two-segment `:id` at all, whatever the order, which is a property of the
 * path rather than of the configuration. `users/me/...` is also what `users/me/notes` already uses
 * for the same "this account, whoever is asking" meaning.
 */
@Controller('users/me/announcement')
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
