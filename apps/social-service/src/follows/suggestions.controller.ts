import { Body, Controller, Get, Headers, Post as HttpPost, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { SuggestionsService, type Suggestions } from './suggestions.service';

/**
 * Dismissals one account may write per minute. A person clearing a carousel presses a handful of
 * X's; a loop writing rows for the directory is stopped. The route has no `:id`, so the bucket of
 * `UserResourceThrottlerGuard` is the caller alone.
 */
export const SUGGESTION_DISMISSALS_PER_MINUTE = 60;

/**
 * THE CALLER'S FOLLOW SUGGESTIONS (engagement WP-5), under `/api/posts/...` beside the follow
 * routes, so nginx needs no new prefix: `me/suggestions` has a literal second segment no post route
 * uses. Always the CALLER's (the header, never an id from the URL or the body).
 */
@Controller('posts')
@UseGuards(NginxAuthGuard)
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  /**
   * `{ people, entities }`: up to 20 people (each with `mutual` and up to three `faces`) and 10
   * entities. `exclude` drops one person - the account just followed ("Suivez aussi...", L15) -
   * and `limit` caps the people (at most 20).
   */
  @Get('me/suggestions')
  list(
    @Headers('x-user-id') userId: string,
    @Query('limit') limit?: string,
    @Query('exclude') exclude?: string
  ): Promise<Suggestions> {
    const n = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return this.suggestions.suggestionsFor(userId, {
      peopleLimit: Number.isFinite(n) ? n : undefined,
      exclude: exclude || undefined,
    });
  }

  /** `{ kind: 'user' | 'association', targetId }`: never suggest it again. 400 SUGGESTION_DISMISS_INVALID. */
  @HttpPost('me/suggestions/dismiss')
  @UseGuards(UserResourceThrottlerGuard)
  @Throttle({ default: { limit: SUGGESTION_DISMISSALS_PER_MINUTE, ttl: 60_000 } })
  dismiss(
    @Headers('x-user-id') userId: string,
    @Body() body: { kind?: unknown; targetId?: unknown }
  ): Promise<{ ok: true }> {
    return this.suggestions.dismiss(userId, body?.kind, body?.targetId);
  }
}
