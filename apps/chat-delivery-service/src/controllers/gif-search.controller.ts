import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response as ExpressResponse } from 'express';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import {
  GIF_MAX_PAGE,
  GIF_QUERY_MAX_LENGTH,
  type GifPage,
  KlipyHttpError,
  KlipyMalformedAnswerError,
  KlipyUnreachableError,
  fetchKlipyPage,
} from '../utils/klipy';
import { TtlCache } from '../utils/ttl-cache';

/** How long one page of results is answered from memory. Trending is the same for everybody. */
export const GIF_CACHE_TTL_MS = 10 * 60 * 1000;

/** Requests one user may make per minute: a debounced search plus scrolling, with headroom. */
export const GIF_SEARCH_LIMIT_PER_MINUTE = 60;

/**
 * The `code` of the 503 body when this estate has no KLIPY key. A 503 alone does not say it: nginx
 * and the edge answer 503 of their own when an upstream is down, and the client must not call that
 * "not configured" - so the discriminator is one only this route emits.
 */
export const GIF_SEARCH_NOT_CONFIGURED = 'gif_search_not_configured';

/**
 * THE GIF PICKER'S SEARCH, ANSWERED BY THE SERVER (owner decision 2026-10-16).
 *
 * The browser used to call KLIPY directly, handing it the query, the reader's IP and a per-install
 * identifier; now it calls this route and KLIPY sees only this server, the query and one shared
 * constant (`utils/klipy.ts`). The key stays in this process's environment (`KLIPY_API_KEY`).
 *
 * Authenticated (nginx's `auth_request` plus `HeaderAuthGuard`) and rate-limited per user, so the
 * route is not a free KLIPY proxy for anybody who finds it. The query is never logged here - only
 * its length - and nginx drops this route's whole query from its access line, which carries the
 * reader's address (`Dockerfile.frontend`, `$logged_request_uri`).
 * [chat](../../../../docs/wiki/frontend/modules/chat.md)
 */
@Controller()
export class GifSearchController {
  private readonly logger = new Logger(GifSearchController.name);

  /**
   * Only an ANSWER is cached: a KLIPY error or a transport failure never reaches it. The key holds
   * the query, so the cache is bounded in size and in time and lives in this process only.
   */
  static readonly cache = new TtlCache<GifPage>(500);

  /**
   * Whether this process has already said it has no key. The state is known and does not change
   * while the process lives, so it is reported ONCE rather than on every request (the deploy warns
   * about the absent key too, from the env manifest).
   */
  static missingKeyReported = false;

  /**
   * One page of trending GIFs (no `q`) or of a search, as `{ gifs, hasNext }`.
   * 400 on a malformed query or page, 503 with `code: GIF_SEARCH_NOT_CONFIGURED` when this estate
   * has no KLIPY key, 502 when KLIPY did not answer usefully.
   */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: GIF_SEARCH_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @Get('mls/gifs')
  async search(
    @Query('q') rawQuery: unknown,
    @Query('page') rawPage: unknown,
    @Res({ passthrough: true }) res: ExpressResponse
  ): Promise<GifPage> {
    if (rawQuery !== undefined && typeof rawQuery !== 'string') {
      throw new BadRequestException('q must be a single string');
    }
    if (rawPage !== undefined && typeof rawPage !== 'string') {
      throw new BadRequestException('page must be a single value');
    }
    const query = (rawQuery ?? '').toString().trim();
    if (query.length > GIF_QUERY_MAX_LENGTH) {
      throw new BadRequestException(`q is longer than ${GIF_QUERY_MAX_LENGTH} characters`);
    }
    const page = rawPage === undefined ? 1 : Number(rawPage);
    if (!Number.isInteger(page) || page < 1 || page > GIF_MAX_PAGE) {
      throw new BadRequestException(`page must be an integer from 1 to ${GIF_MAX_PAGE}`);
    }
    const kind = query ? 'search' : 'trending';

    const apiKey = process.env.KLIPY_API_KEY?.trim();
    if (!apiKey) {
      if (!GifSearchController.missingKeyReported) {
        GifSearchController.missingKeyReported = true;
        this.logger.warn(
          '[GIF_SEARCH] KLIPY_API_KEY is not configured - every GIF search of this process answers 503'
        );
      }
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: GIF_SEARCH_NOT_CONFIGURED,
        message: 'GIF search is not configured on this estate',
      });
    }

    const cacheKey = `${query.toLowerCase()}\u0000${page}`;
    const cached = GifSearchController.cache.get(cacheKey);
    if (cached) {
      this.logger.debug(`[GIF_SEARCH] ${kind} p${page} (q length ${query.length}): cache hit`);
      return this.answer(res, cached);
    }

    try {
      const { page: result, received, dropped } = await fetchKlipyPage(apiKey, query, page);
      if (dropped > 0) {
        this.logger.warn(
          `[GIF_SEARCH] ${dropped} of ${received} results declared no size and were left out`
        );
      }
      GifSearchController.cache.set(cacheKey, result, GIF_CACHE_TTL_MS);
      this.logger.debug(
        `[GIF_SEARCH] ${kind} p${page} (q length ${query.length}): ${result.gifs.length} ` +
          `(next: ${result.hasNext})`
      );
      return this.answer(res, result);
    } catch (error) {
      if (error instanceof KlipyHttpError) {
        this.logger.warn(`[GIF_SEARCH] ${kind} p${page}: KLIPY answered ${error.status}`);
      } else if (error instanceof KlipyUnreachableError) {
        this.logger.warn(`[GIF_SEARCH] ${kind} p${page}: KLIPY unreachable: ${error.message}`);
      } else if (error instanceof KlipyMalformedAnswerError) {
        this.logger.warn(`[GIF_SEARCH] ${kind} p${page}: KLIPY answered 200 with ${error.message}`);
      } else {
        this.logger.error(`[GIF_SEARCH] ${kind} p${page}: unexpected failure: ${String(error)}`);
      }
      throw new BadGatewayException('The GIF provider did not answer');
    }
  }

  /**
   * Returns an ANSWER with its cache header. Set here and nowhere else, so a 502 never carries a
   * `max-age`: only an answer may be cached, by the browser as by this process.
   */
  private answer(res: ExpressResponse, page: GifPage): GifPage {
    // The search is the reader's: no shared cache may keep it.
    res.setHeader('Cache-Control', 'private, max-age=300');
    return page;
  }
}
