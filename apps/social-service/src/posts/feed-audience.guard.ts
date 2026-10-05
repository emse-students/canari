import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { Post } from './entities/post.entity';
import { readInFeedAudience } from '../spaces/reader-spaces';

/**
 * REFUSES A READ OF THE SOCIAL FEED TO ANYBODY OUTSIDE ITS AUDIENCE.
 *
 * THE AUDIENCE SINCE WP6b (docs/wiki/profiles-and-access.md): a global admin, anybody with at least
 * one space (a cursus formation on their own campus), or a member of at least one association. It
 * was "ICM students, plus global admins" until then. This gate only says whether the feed is open
 * at all; WHICH posts a reader gets is the per-post predicate (`postVisibleToViewerSql`), applied
 * by every read behind it.
 *
 * WHY IT EXISTS. `/api/posts` DOES carry `auth_request /internal/auth/verify` in the edge config,
 * which is exactly what an access check looks like - but `/api/auth/verify` answers **200 for a
 * logged-OUT caller too**, carrying `x-logged-in: false` so pages can render signed out, and nginx
 * treats any 2xx as permission granted. Measured 2026-09-10: an anonymous `GET /api/posts?limit=1`
 * returned 200 with post bodies. **A gate is only a gate if it can say no**, and that verifier
 * never does; its job is to say WHO you are.
 *
 * WHY IT ASKS THE DATABASE AND IGNORES `x-global-admin`. The header is trustworthy - nginx sets
 * it and `NginxAuthGuard` proves the request came through nginx - but admins are already inside
 * the audience predicate, so consulting the header would state part of the rule a second time.
 * One predicate, one home (`spaces/reader-spaces.ts`), asked of the table that holds the answer:
 * campus and cursus are not in the JWT anyway.
 *
 * WHY 403 AND NOT 404. The feed's existence is no secret; the client asks `GET /api/posts/audience`
 * (the same SQL) and redirects a reader outside the audience away from `/posts`, so a
 * distinguishable refusal is what lets the two agree. A single POST the reader may not see is a
 * 404 instead (`PostsService.getById`) - that one's existence IS the thing to hide.
 *
 * PAIR IT WITH `NginxAuthGuard`, ALWAYS, and in that order - this guard reads `x-user-id` and
 * trusts it, exactly as `GlobalAdminGuard` trusts `x-global-admin`.
 */
@Injectable()
export class FeedAudienceGuard implements CanActivate {
  private readonly logger = new Logger(FeedAudienceGuard.name);

  constructor(@InjectRepository(Post) private readonly postRepo: Repository<Post>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim();

    // NginxAuthGuard is what refuses an absent identity, and it runs first. Reaching here with
    // none means the pair was not applied - a wiring mistake, refused rather than guessed at.
    if (!userId) {
      this.logger.warn('[FEED_GATE] no x-user-id behind the guard - NginxAuthGuard not applied?');
      throw new ForbiddenException('The social feed is not available to this account');
    }

    if (!(await readInFeedAudience(this.postRepo.manager, userId))) {
      this.logger.debug(`[FEED_GATE] refused ${userId.slice(0, 8)}: no space, no association`);
      throw new ForbiddenException('The social feed is not available to this account');
    }
    return true;
  }
}
