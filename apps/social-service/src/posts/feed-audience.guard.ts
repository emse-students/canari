import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { Post } from './entities/post.entity';
import { IS_FEED_AUDIENCE_SQL } from './feed-audience';

/**
 * REFUSES A READ OF THE SOCIAL FEED TO ANYBODY OUTSIDE ITS AUDIENCE - which until now was nobody,
 * because there was no server-side gate at all.
 *
 * WHAT WAS ACTUALLY WRONG, and it is not what it looked like. "ICM students, plus global admins"
 * was stated only in the CLIENT. `/api/posts` DOES carry `auth_request /internal/auth/verify` in
 * the edge config, which is exactly what an access check looks like - and reading that location
 * block is what hid this for as long as it lasted. But `/api/auth/verify` answers **200 for a
 * logged-OUT caller too**, carrying `x-logged-in: false` so pages can render signed out, and
 * nginx treats any 2xx as permission granted. Measured 2026-09-10: an anonymous
 * `GET /api/posts?limit=1` returned 200 with post bodies. **A gate is only a gate if it can say
 * no**, and that verifier never does; its job is to say WHO you are.
 *
 * WHY IT ASKS THE DATABASE AND IGNORES `x-global-admin`. The header is trustworthy - nginx sets
 * it and `NginxAuthGuard` proves the request came through nginx - but admins are already inside
 * the audience predicate, so consulting the header would state half the rule a second time, in a
 * second place, in a second language. One predicate, one home (`feed-audience.ts`), asked of the
 * table that actually holds the answer. `formation` is not in the JWT anyway, so half the rule
 * would need the query regardless, and a rule split across two sources is the shape this whole
 * defect had.
 *
 * WHY 403 AND NOT 404. The absence of a gate is the defect; hiding the endpoint's existence is a
 * different decision, and one the client cannot act on - it already redirects a non-ICM user away
 * from `/posts`, so a distinguishable refusal is what lets the two agree. Anonymous callers never
 * reach here: `NginxAuthGuard` runs first and answers 401.
 *
 * PAIR IT WITH `NginxAuthGuard`, ALWAYS, and in that order - this guard reads `x-user-id` and
 * trusts it, exactly as `GlobalAdminGuard` trusts `x-global-admin`.
 */
@Injectable()
export class FeedAudienceGuard implements CanActivate {
  constructor(@InjectRepository(Post) private readonly postRepo: Repository<Post>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim();

    // NginxAuthGuard is what refuses an absent identity, and it runs first. Reaching here with
    // none means the pair was not applied - a wiring mistake, refused rather than guessed at.
    if (!userId) {
      throw new ForbiddenException('The social feed is not available to this account');
    }

    const rows: unknown = await this.postRepo.manager.query(IS_FEED_AUDIENCE_SQL, [userId]);
    const inAudience = Array.isArray(rows) && rows.length > 0 && rows[0].inAudience === true;
    if (!inAudience) {
      throw new ForbiddenException('The social feed is not available to this account');
    }
    return true;
  }
}
