import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { PinPostDto } from './dto/post.dto';
import { SpacePinsService, type PinActor } from './space-pins.service';

/**
 * PINS PER SPACE (WP-PIN, docs/wiki/spaces-and-audiences-reform.md section 11). Its own controller
 * under the same `posts` prefix: no route of `PostsController` has a second segment these two-segment
 * paths could match, and the pin is no longer moderation, so it no longer sits beside hide/unmask.
 *
 * Every refusal is typed (`space-pins.ts`): `space_required` / `space_pin_limit` /
 * `post_not_in_space` 409, `space_pin_forbidden` 403, `space_not_found` 404.
 */
@Controller('posts')
export class SpacePinsController {
  constructor(private readonly pins: SpacePinsService) {}

  /**
   * The governor's list of one space: its visible pins, the 3 readers are shown first, then those
   * "en attente" (kept, not shown). The platform admin, or a `MODERATE` holder of that space's BDE.
   */
  @UseGuards(NginxAuthGuard)
  @Get('space-pins/:spaceId')
  listSpacePins(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('spaceId', ParseUUIDPipe) spaceId: string
  ) {
    return this.pins.listForSpace(spaceId, actorOf(xUserId, xGlobalAdmin));
  }

  /**
   * Pins a post in ONE space (`spaceId`), for that space's readers only. With no body (an older
   * client), pins in the one space where the caller may pin it, or answers `space_required`.
   */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/pin')
  pinPost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: PinPostDto | undefined
  ) {
    return this.pins.pin(postId, actorOf(xUserId, xGlobalAdmin), body?.spaceId);
  }

  /** Unpins a post from ONE space. With no body, from the one space where it is pinned and governed. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/unpin')
  unpinPost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: PinPostDto | undefined
  ) {
    return this.pins.unpin(postId, actorOf(xUserId, xGlobalAdmin), body?.spaceId);
  }
}

/** The caller as the pin rules read it. */
function actorOf(userId: string, globalAdminHeader: string | undefined): PinActor {
  return { userId, isGlobalAdmin: globalAdminHeader === 'true' };
}
