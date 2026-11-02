import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post as HttpPost,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { ModerationService } from '../moderation/moderation.service';
import { FOLLOW_PAGE_MAX } from '../follows/follow-requests.service';
import { MemberRepostsService } from './member-reposts.service';
import { RepostAccountConsentDto, RepostPostConsentDto } from './dto/post.dto';

/**
 * Reposts and take-backs one account may make per minute, per route, ALL posts together: the
 * parameter is `:postId`, which `UserResourceThrottlerGuard` does not read, so the bucket is the
 * caller alone. A person reposting a few posts in a row stays far below; a loop - a stuck tab, a
 * script - is stopped. Who is TOLD is once per (post, reader) from durable state
 * (`member_repost_notices`); this bounds the WRITES and the feed-cache drops they cause.
 *
 * PER REPLICA: `ThrottlerModule.forRoot` (`app.module.ts`) names no storage, so every count lives
 * in one process's memory. With N social-service replicas behind nginx, a caller can reach up to
 * N times each limit here, and a restart forgets the counts. It bounds a loop; it is not a quota.
 */
export const MEMBER_REPOST_WRITES_PER_MINUTE = 20;

/**
 * Consent changes (the account setting, a post's override) one account may make per minute, per
 * route: each one that withdraws consent deletes reposts and drops their audiences' feeds.
 */
export const REPOST_CONSENT_WRITES_PER_MINUTE = 10;

/**
 * Reads of the caller's own repost state per minute, per route: the settings screen asks its
 * consent once per opening, the author's reposter sheet one page per scroll.
 */
export const REPOST_SETTINGS_READS_PER_MINUTE = 60;

/**
 * Member reposts (WP-F6) under `/api/posts/...`. The caller is always the header, never an id from
 * the URL: a person reposts, takes back and consents for THEMSELVES only.
 */
@Controller('posts')
@UseGuards(NginxAuthGuard)
export class MemberRepostsController {
  constructor(
    private readonly reposts: MemberRepostsService,
    private readonly moderation: ModerationService
  ) {}

  /** The caller's account-wide consent ("Autoriser mes abonnes a republier mes posts"). */
  @Get('me/repost-settings')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: REPOST_SETTINGS_READS_PER_MINUTE, ttl: 60_000 } })
  myRepostSettings(@Headers('x-user-id') xUserId: string) {
    return this.reposts.accountConsent(xUserId);
  }

  /** Sets it; turning it off removes, at once, every repost it no longer covers. */
  @Put('me/repost-settings')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: REPOST_CONSENT_WRITES_PER_MINUTE, ttl: 60_000 } })
  setMyRepostSettings(
    @Headers('x-user-id') xUserId: string,
    @Body() body: RepostAccountConsentDto
  ) {
    return this.reposts.setAccountConsent(xUserId, body.allowReposts);
  }

  /** Reposts the post to the caller's accepted followers. A muted account may not speak. */
  @HttpPost(':postId/reposts')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: MEMBER_REPOST_WRITES_PER_MINUTE, ttl: 60_000 } })
  async repost(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string
  ) {
    if (await this.moderation.isUserMuted(xUserId)) {
      throw new ForbiddenException('Your account has been restricted. You cannot post or react.');
    }
    return this.reposts.repost(postId, xUserId);
  }

  /** The caller takes their own repost back. */
  @Delete(':postId/reposts')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: MEMBER_REPOST_WRITES_PER_MINUTE, ttl: 60_000 } })
  unrepost(@Headers('x-user-id') xUserId: string, @Param('postId', ParseUUIDPipe) postId: string) {
    return this.reposts.unrepost(postId, xUserId);
  }

  /**
   * The AUTHOR's list of who reposted their personal post, newest first (`limit` at most 100, the
   * next page after `after`, the `cursor` of the last entry). 404 to anyone else.
   */
  @Get(':postId/reposts')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: REPOST_SETTINGS_READS_PER_MINUTE, ttl: 60_000 } })
  reposters(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Query('limit', new DefaultValuePipe(FOLLOW_PAGE_MAX), ParseIntPipe) limit: number,
    @Query('after') after?: string
  ) {
    return this.reposts.reposters(postId, xUserId, limit, after);
  }

  /** The AUTHOR removes one person's repost of their personal post. 404 to anyone else. */
  @Delete(':postId/reposts/:reposterId')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: MEMBER_REPOST_WRITES_PER_MINUTE, ttl: 60_000 } })
  removeRepost(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('reposterId') reposterId: string
  ) {
    return this.reposts.removeRepostAsAuthor(postId, xUserId, reposterId);
  }

  /** The AUTHOR's override for one personal post: true, false, or null to follow the setting. */
  @Put(':postId/repost-consent')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: REPOST_CONSENT_WRITES_PER_MINUTE, ttl: 60_000 } })
  setPostConsent(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: RepostPostConsentDto
  ) {
    return this.reposts.setPostConsent(postId, xUserId, body.allowReposts);
  }
}
