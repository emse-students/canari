import { Body, Controller, Get, Headers, Param, Put, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import {
  AccountBellsService,
  type BellLevel,
  type BellTargetKind,
  type ReducedBell,
} from './account-bells.service';

/**
 * THE CALLER'S BELL on one account (engagement WP-3): `GET` reads it, `PUT { level }` sets it -
 * `all` (posts and lives, the default), `lives`, or `none`. Under `/api/posts/...` beside the follow
 * routes; `me/bells/:kind/:targetId` has a literal second segment no post route uses. Always the
 * CALLER's row (the header, never an id from the URL), and no route answers another reader's level:
 * the followed account never learns it.
 */
@Controller('posts')
@UseGuards(NginxAuthGuard)
export class AccountBellsController {
  constructor(private readonly bells: AccountBellsService) {}

  /** Every account the caller reduced (`lives` or `none`), for the notification settings. */
  @Get('me/bells')
  list(@Headers('x-user-id') userId: string): Promise<ReducedBell[]> {
    return this.bells.listReduced(userId);
  }

  /** The caller's level for `kind` (`user` or `association`) `targetId`; `all` when none is stored. */
  @Get('me/bells/:kind/:targetId')
  async level(
    @Headers('x-user-id') userId: string,
    @Param('kind') kind: string,
    @Param('targetId') targetId: string
  ): Promise<{ level: BellLevel }> {
    return { level: await this.bells.levelOf(userId, kind as BellTargetKind, targetId) };
  }

  /**
   * Sets the caller's level. Idempotent. 400 BELL_INVALID for an unknown kind or level; 404
   * BELL_TARGET_NOT_FOUND for an association that does not exist or a person the caller does not
   * follow (accepted).
   */
  @Put('me/bells/:kind/:targetId')
  setLevel(
    @Headers('x-user-id') userId: string,
    @Param('kind') kind: string,
    @Param('targetId') targetId: string,
    @Body() body: { level?: unknown }
  ): Promise<{ level: BellLevel }> {
    return this.bells.setLevel(userId, kind as BellTargetKind, targetId, body?.level as BellLevel);
  }
}
