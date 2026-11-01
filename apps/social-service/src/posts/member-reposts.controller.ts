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
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { ModerationService } from '../moderation/moderation.service';
import { MemberRepostsService } from './member-reposts.service';
import { RepostAccountConsentDto, RepostPostConsentDto } from './dto/post.dto';

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
  myRepostSettings(@Headers('x-user-id') xUserId: string) {
    return this.reposts.accountConsent(xUserId);
  }

  /** Sets it; turning it off removes, at once, every repost it no longer covers. */
  @Put('me/repost-settings')
  setMyRepostSettings(
    @Headers('x-user-id') xUserId: string,
    @Body() body: RepostAccountConsentDto
  ) {
    return this.reposts.setAccountConsent(xUserId, body.allowReposts);
  }

  /** Reposts the post to the caller's accepted followers. A muted account may not speak. */
  @HttpPost(':postId/reposts')
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
  unrepost(@Headers('x-user-id') xUserId: string, @Param('postId', ParseUUIDPipe) postId: string) {
    return this.reposts.unrepost(postId, xUserId);
  }

  /** The AUTHOR's override for one personal post: true, false, or null to follow the setting. */
  @Put(':postId/repost-consent')
  setPostConsent(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: RepostPostConsentDto
  ) {
    return this.reposts.setPostConsent(postId, xUserId, body.allowReposts);
  }
}
