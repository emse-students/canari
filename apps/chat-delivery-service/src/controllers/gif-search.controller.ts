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
  fetchKlipyPage,
} from '../utils/klipy';
import { TtlCache } from '../utils/ttl-cache';

/** How long one page of results is answered from memory. Trending is the same for everybody. */
export const GIF_CACHE_TTL_MS = 10 * 60 * 1000;

/** Requests one user may make per minute: a debounced search plus scrolling, with headroom. */
export const GIF_SEARCH_LIMIT_PER_MINUTE = 60;

/**
 * THE GIF PICKER'S SEARCH, ANSWERED BY THE SERVER (owner decision 2026-10-16).
 *
 * The browser used to call KLIPY directly, handing it the query, the reader's IP and a per-install
 * identifier; now it calls this route and KLIPY sees only this server, the query and one shared
 * constant (`utils/klipy.ts`). The key stays in this process's environment (`KLIPY_API_KEY`).
 *
 * Authenticated (nginx's `auth_request` plus `HeaderAuthGuard`) and rate-limited per user, so the
 * route is not a free KLIPY proxy for anybody who finds it. The query is NEVER logged - only its
 * length - because the point of the route is that a search stays between the reader and us.
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
   * One page of trending GIFs (no `q`) or of a search, as `{ gifs, hasNext }`.
   * 400 on a malformed query or page, 503 when this estate has no KLIPY key, 502 when KLIPY did
   * not answer usefully - the client shows its error state for all three.
   */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: GIF_SEARCH_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @Get('mls/gifs')
  async search(
    @Query('q') rawQuery: string | undefined,
    @Query('page') rawPage: string | undefined,
    @Res({ passthrough: true }) res: ExpressResponse
  ): Promise<GifPage> {
    if (rawQuery !== undefined && typeof rawQuery !== 'string') {
      throw new BadRequestException('q must be a single string');
    }
    const query = (rawQuery ?? '').trim();
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
      this.logger.error(`[GIF_SEARCH] KLIPY_API_KEY is not configured - ${kind} refused`);
      throw new ServiceUnavailableException('GIF search is not configured on this estate');
    }

    // The search is the reader's: the browser must not keep it in a shared cache either.
    res.setHeader('Cache-Control', 'private, max-age=300');

    const cacheKey = `${query.toLowerCase()}\u0000${page}`;
    const cached = GifSearchController.cache.get(cacheKey);
    if (cached) {
      this.logger.debug(`[GIF_SEARCH] ${kind} p${page} (q length ${query.length}): cache hit`);
      return cached;
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
      return result;
    } catch (error) {
      if (error instanceof KlipyHttpError) {
        this.logger.warn(`[GIF_SEARCH] ${kind} p${page}: KLIPY answered ${error.status}`);
      } else {
        this.logger.warn(`[GIF_SEARCH] ${kind} p${page}: KLIPY unreachable: ${String(error)}`);
      }
      throw new BadGatewayException('The GIF provider did not answer');
    }
  }
}
