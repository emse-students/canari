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
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { ModerationService } from '../moderation/moderation.service';
import { RepublicationsService } from './republications.service';
import { PersonalRepublicationsService } from './personal-republications.service';
import { RepublicationTargetDto } from './dto/post.dto';

/**
 * Republication (D38, D38b) under `/api/posts/...`. Its own controller rather than more routes on
 * `PostsController`: every segment after `:postId` is a literal no route there uses, the author's
 * inbox is `me/republication-requests` (two segments, which no `GET` there has a shape for), and the
 * rights are the republication services' alone. Accepting, refusing and withdrawing a proposal are
 * generic and live in `proposals/proposals.controller.ts`.
 */
@Controller('posts')
@UseGuards(NginxAuthGuard)
export class RepublicationsController {
  constructor(
    private readonly republications: RepublicationsService,
    private readonly personal: PersonalRepublicationsService,
    private readonly moderation: ModerationService
  ) {}

  /** A muted account may not speak, and republishing, proposing or asking is speaking. */
  private async assertNotMuted(userId: string): Promise<void> {
    if (await this.moderation.isUserMuted(userId)) {
      throw new ForbiddenException('Your account has been restricted. You cannot post or react.');
    }
  }

  /**
   * D38b: the republication requests waiting for the CALLER's answer - their own inbox, and nobody
   * else's (the caller is the header, never an id from the URL).
   */
  @Get('me/republication-requests')
  myRepublicationRequests(@Headers('x-user-id') xUserId: string) {
    return this.personal.inbox(xUserId);
  }

  /**
   * D38b: HOW MANY requests wait for the caller's answer - one indexed count, so a page that only
   * draws the way to the inbox never runs the inbox's per-request audience counts.
   */
  @Get('me/republication-requests/count')
  myRepublicationRequestCount(@Headers('x-user-id') xUserId: string) {
    return this.personal.pendingCount(xUserId);
  }

  /** Republishes the post AS `associationId`, at once: `POST_AS_ASSO` there, and the post in sight. */
  @HttpPost(':postId/republications')
  async republish(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: RepublicationTargetDto
  ) {
    await this.assertNotMuted(xUserId);
    return this.republications.republish(
      postId,
      body.associationId,
      xUserId,
      xGlobalAdmin === 'true'
    );
  }

  /**
   * A republication is withdrawn: by the republishing association, or - for a personal post - by
   * its author, whichever association carries it (D38b).
   */
  @Delete(':postId/republications/:associationId')
  unrepublish(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('associationId', ParseUUIDPipe) associationId: string
  ) {
    return this.republications.unrepublish(postId, associationId, xUserId, xGlobalAdmin === 'true');
  }

  /** Sends the post to ANOTHER association, which accepts or refuses it on its management page. */
  @HttpPost(':postId/republication-proposals')
  async propose(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: RepublicationTargetDto
  ) {
    await this.assertNotMuted(xUserId);
    return this.republications.propose(
      postId,
      body.associationId,
      xUserId,
      xGlobalAdmin === 'true'
    );
  }

  /**
   * D38b: asks the AUTHOR of a personal post to let `associationId` republish it. Nothing is
   * visible until they accept; they are told at once. The administrator tier grants nothing here:
   * the caller must HOLD `POST_AS_ASSO` in that association.
   */
  @HttpPost(':postId/republication-requests')
  async requestPersonal(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: RepublicationTargetDto
  ) {
    await this.assertNotMuted(xUserId);
    return this.personal.request(postId, body.associationId, xUserId);
  }
}
