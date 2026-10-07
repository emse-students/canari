import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Headers,
  Param,
  ParseUUIDPipe,
  Post as HttpPost,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { ModerationService } from '../moderation/moderation.service';
import { RepublicationsService } from './republications.service';
import { RepublicationTargetDto } from './dto/post.dto';

/**
 * Republication (D38) under `/api/posts/:postId/...`. Its own controller rather than more routes on
 * `PostsController`: every segment after `:postId` is a literal no route there uses, and the rights
 * are `RepublicationsService`'s alone. Accepting, refusing and withdrawing a proposal are generic
 * and live in `proposals/proposals.controller.ts`.
 */
@Controller('posts')
@UseGuards(NginxAuthGuard)
export class RepublicationsController {
  constructor(
    private readonly republications: RepublicationsService,
    private readonly moderation: ModerationService
  ) {}

  /** A muted account may not speak, and republishing or proposing is speaking. */
  private async assertNotMuted(userId: string): Promise<void> {
    if (await this.moderation.isUserMuted(userId)) {
      throw new ForbiddenException('Your account has been restricted. You cannot post or react.');
    }
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

  /** An association withdraws its own republication. */
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
}
