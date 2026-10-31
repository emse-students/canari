import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post as HttpPost,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { ModerationService } from '../moderation/moderation.service';
import { FOLLOW_PAGE_MAX, FollowRequestsService } from './follow-requests.service';
import { FollowsService } from './follows.service';
import { sameSideOfReviewCohort } from '../review-cohort';

/**
 * Asks one account may make per minute, ALL targets together: the route's parameter is `:userId`,
 * which `UserResourceThrottlerGuard` does not read, so its bucket is the caller alone. A person
 * following a handful of people in a row stays far below; a loop - a stuck tab, a script walking
 * the directory - is stopped. The notice itself is once per pair from durable state
 * (`user_follow_notices`); this bounds the WRITES.
 */
export const FOLLOW_ASKS_PER_MINUTE = 30;

/**
 * Following a PERSON, and answering who asks (WP-F1, WP-F2), under `/api/posts/...` - the prefix
 * the follow routes always had, so no client changes its URLs. Its own controller rather than more
 * routes on `PostsController`: the request answers notify through `PostNotificationsService`, which
 * `PostsModule` provides, and a follows controller inside it would make the two modules import each
 * other. Every inbox is the CALLER's (`me/...`, the caller is the header, never an id from the URL).
 *
 * Shapes no `PostsController` route has: `users/:userId/follow*` (a literal first segment) and
 * `me/follow-requests...` (two or four segments, the second a literal no post route uses).
 */
@Controller('posts')
@UseGuards(NginxAuthGuard)
export class FollowRequestsController {
  constructor(
    private readonly requests: FollowRequestsService,
    private readonly follows: FollowsService,
    private readonly moderation: ModerationService
  ) {}

  /**
   * Asks to follow a user: a `pending` request the user answers (every personal account is
   * private). Answers `{ ok, status }`. A muted account may not ask: a request is a push to a
   * person, and a restricted account may not reach people (decided 2026-10-27). 404
   * FOLLOW_TARGET_NOT_FOUND when the id names no person (an association is followed through its own
   * route), 403 FOLLOW_BLOCKED across a block; throttled per caller.
   */
  @HttpPost('users/:userId/follow')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: FOLLOW_ASKS_PER_MINUTE, ttl: 60_000 } })
  async followUser(@Headers('x-user-id') xUserId: string, @Param('userId') userId: string) {
    if (userId === xUserId) throw new BadRequestException('Cannot follow yourself');
    if (await this.moderation.isUserMuted(xUserId)) {
      throw new ForbiddenException('Your account has been restricted. You cannot post or react.');
    }
    return this.requests.ask(xUserId, userId);
  }

  /** Unfollows a user, or withdraws a request not answered yet. */
  @Delete('users/:userId/follow')
  unfollowUser(@Headers('x-user-id') xUserId: string, @Param('userId') userId: string) {
    return this.requests.leave(xUserId, userId);
  }

  /**
   * Where the calling user stands with the given user: `status` is `accepted`, `pending` or `null`.
   * `following` keeps the meaning a client older than the request screens gives it - its button
   * shows the leave action - so it is true for a pending request too, and that client can withdraw
   * what it asked ([legacy-compatibility](docs/wiki/legacy-compatibility.md)).
   */
  @Get('users/:userId/follow-status')
  async getUserFollowStatus(
    @Headers('x-user-id') xUserId: string,
    @Param('userId') userId: string
  ) {
    // Across the review cohort's boundary there is no follow to report, even one written before
    // the rule (review-cohort.ts): it reads as none, as it does in every list.
    if (!sameSideOfReviewCohort(xUserId, userId)) return { following: false, status: null };
    const status = await this.follows.userFollowStatus(xUserId, userId);
    return { following: status !== null, status };
  }

  /** The follow requests waiting for the caller's answer, newest first (`limit` at most 100). */
  @Get('me/follow-requests')
  incoming(
    @Headers('x-user-id') xUserId: string,
    @Query('limit', new DefaultValuePipe(FOLLOW_PAGE_MAX), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number
  ) {
    return this.requests.incoming(xUserId, limit, offset);
  }

  /** HOW MANY follow requests wait for the caller's answer - for a badge, without the list. */
  @Get('me/follow-requests/count')
  incomingCount(@Headers('x-user-id') xUserId: string) {
    return this.requests.incomingCount(xUserId);
  }

  /** The caller accepts `userId`'s request; 404 when there is none pending. */
  @HttpPost('me/follow-requests/:userId/accept')
  accept(@Headers('x-user-id') xUserId: string, @Param('userId') userId: string) {
    return this.requests.accept(xUserId, userId);
  }

  /** The caller refuses `userId`'s request: deleted, nobody told; 404 when there is none pending. */
  @HttpPost('me/follow-requests/:userId/refuse')
  refuse(@Headers('x-user-id') xUserId: string, @Param('userId') userId: string) {
    return this.requests.refuse(xUserId, userId);
  }

  /**
   * The requests the CALLER sent and nobody answered yet, newest first; each is withdrawn with
   * `DELETE users/:userId/follow`.
   */
  @Get('me/follow-requests/sent')
  sent(
    @Headers('x-user-id') xUserId: string,
    @Query('limit', new DefaultValuePipe(FOLLOW_PAGE_MAX), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number
  ) {
    return this.requests.outgoing(xUserId, limit, offset);
  }

  /** The caller's own ACCEPTED followers, newest first. Nobody reads another person's list. */
  @Get('me/followers')
  followers(
    @Headers('x-user-id') xUserId: string,
    @Query('limit', new DefaultValuePipe(FOLLOW_PAGE_MAX), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number
  ) {
    return this.requests.followers(xUserId, limit, offset);
  }

  /** The caller removes `userId` from their followers: deleted, nobody told; 404 if not one. */
  @Delete('me/followers/:userId')
  removeFollower(@Headers('x-user-id') xUserId: string, @Param('userId') userId: string) {
    return this.requests.removeFollower(xUserId, userId);
  }
}
