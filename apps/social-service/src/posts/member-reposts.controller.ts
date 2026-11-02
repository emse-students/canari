import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post as HttpPost,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { ModerationService } from '../moderation/moderation.service';
import { MemberRepostsService } from './member-reposts.service';
import { RepostAccountConsentDto, RepostPostConsentDto } from './dto/post.dto';

/**
 * Reposts and take-backs one account may make per minute, per route, ALL posts together: the
 * parameter is `:postId`, which `UserResourceThrottlerGuard` does not read, so the bucket is the
 * caller alone. A person reposting a few posts in a row stays far below; a loop - a stuck tab, a
 * script - is stopped. Who is TOLD is once per (post, reader) from durable state
 * (`member_repost_notices`); this bounds the WRITES and the feed-cache drops they cause.
 */
export const MEMBER_REPOST_WRITES_PER_MINUTE = 20;

/**
 * Consent changes (the account setting, a post's override) one account may make per minute, per
 * route: each one that withdraws consent deletes reposts and drops their audiences' feeds.
 */
export const REPOST_CONSENT_WRITES_PER_MINUTE = 10;

/** Reads of the caller's own consent per minute: the settings screen asks once per opening. */
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
