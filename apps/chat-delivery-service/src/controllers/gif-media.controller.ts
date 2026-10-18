import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response as ExpressResponse } from 'express';
import { ClientIpThrottlerGuard } from '../guards/client-ip-throttler.guard';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import {
  GIF_MEDIA_CACHE_ENTRY_MAX_BYTES,
  GIF_MEDIA_CACHE_MAX_BYTES,
  GIF_MEDIA_FETCH_DEADLINE_MS,
  GIF_MEDIA_LIMIT_PER_MINUTE,
  GIF_MEDIA_MAX_BYTES,
  GIF_MEDIA_MAX_IN_FLIGHT,
  GIF_MEDIA_TTL_MS,
  GifByteCounter,
  GifMediaRefusedError,
  isGifContentType,
  parseKlipyCdnUrl,
  writeRelayedImageHeaders,
} from '../utils/gif-media';
import { requireTicketSecret, verifyGifMediaTicket } from '../utils/previewTicket';
import { TtlCache } from '../utils/ttl-cache';
import {
  OUTBOUND_BUDGET_MS,
  UpstreamUnreachableError,
  assertSafeExternalUrl,
  errorCause,
  ssrfSafeFetch,
} from '../utils/url-guard';

/** What the browser is told: its own cache only (no shared one), for as long as ours keeps it. */
const GIF_CACHE_CONTROL = `private, max-age=${Math.floor(GIF_MEDIA_TTL_MS / 1000)}`;

/**
 * THE GIF RELAY: A GIF IN A CHAT, FETCHED BY THIS SERVER SO NO READER'S BROWSER ASKS KLIPY FOR IT.
 *
 * `GET mls/gifs/media?url=<KLIPY CDN URL>&t=<ticket>` - the GIF message keeps its original KLIPY URL
 * on the wire (an older client still renders it), and a current client rewrites it to this route at
 * render time (`frontend/src/lib/utils/gifMediaProxy.ts`). KLIPY then sees this server's address,
 * once per cache lifetime, instead of each reader's address, user agent and reading time.
 *
 * - A TICKET, NOT A GUARD: the URL is an `<img src>`, which carries no Bearer and on
 *   `tauri://localhost` no cookie. Its kind has a DAY-long bucket so a GIF keeps one URL in the
 *   reader's HTTP cache (`GIF_MEDIA_TICKET_BUCKET_MS`).
 * - ONE HOST: `static.klipy.com`, https, then the same SSRF guard and pinned dispatcher as the
 *   preview proxy. Redirects are REFUSED, not followed: the allowlist names a host, and a redirect
 *   is a different one.
 * - `image/gif` only, 12 MiB at most (measured), checked on the declared length and on the bytes.
 * - STREAMED: the reader receives bytes as they arrive; the only copy held is the cache's, and only
 *   while the GIF stays under the cache's entry ceiling.
 * - BOUNDED: identical misses share one upstream fetch and its refusal (single-flight; a GIF the
 *   cache could not keep releases its waiters to fetch in parallel), at most
 *   `GIF_MEDIA_MAX_IN_FLIGHT` fetches run at once (beyond: 503 `busy`), each within
 *   `GIF_MEDIA_FETCH_DEADLINE_MS` headers and body included (beyond: 504 `timed-out`), and one
 *   visitor address makes at most `GIF_MEDIA_LIMIT_PER_MINUTE` requests a minute - the ticket is
 *   shared and lasts a day, so it is not what limits a loop.
 * - Every refusal is typed (`GifMediaRefusedError`) and logged under its reason. Refusals are
 *   BODYLESS, like the preview proxy's: the answer is decoded by an `<img>`.
 * [chat](../../../../docs/wiki/frontend/modules/chat.md)
 */
@Controller()
export class GifMediaController {
  private readonly logger = new Logger(GifMediaController.name);

  /**
   * Keyed on the content URL (fragment dropped, query refused), shared by every reader: a GIF of at
   * most 4 MiB sent to a group of forty is fetched from KLIPY once per 24 h. Bounded in bytes as well
   * as in entries.
   */
  static readonly cache = new TtlCache<Buffer>(500, {
    maxWeight: GIF_MEDIA_CACHE_MAX_BYTES,
    weigh: (body) => body.length,
  });

  /**
   * The leading upstream fetch per cache key: what a waiter awaits. It resolves to KLIPY's verdict
   * when KLIPY refused the GIF outright (404, not a GIF, too large...), which the waiters share
   * rather than ask again; to `null` otherwise.
   */
  static readonly inFlight = new Map<string, Promise<GifMediaRefusedError | null>>();

  /** Upstream fetches running right now, leaders and released waiters alike: what the cap counts. */
  static active = 0;

  /**
   * Relays one KLIPY GIF. 401 without a valid ticket; 400 for a URL the allowlist refuses; 404 when
   * KLIPY has no such GIF; 413 over the ceiling; 415 when KLIPY answers something that is not a GIF;
   * 502 when KLIPY redirected, failed or could not be reached; 503 when too many GIFs are already
   * on their way; 504 when KLIPY did not answer within the deadline; 429 (the throttler) past the
   * per-address quota.
   */
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: { limit: GIF_MEDIA_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @Get('mls/gifs/media')
  async relay(
    @Query('url') rawUrl: unknown,
    @Query('t') ticket: unknown,
    @Res() res: ExpressResponse
  ): Promise<void> {
    if (!verifyGifMediaTicket(ticket, requireTicketSecret())) {
      this.logger.warn('[GIF_MEDIA] refused: no valid ticket (401)');
      res.status(401).end();
      return;
    }

    // The reader may leave at any point - scrolled away, closed the conversation. Recorded as the
    // FIRST thing that went wrong, so the destruction it causes downstream is not blamed on KLIPY.
    // A failing stream destroys the response too, so a close AFTER a stream failure is that
    // failure's consequence, not a reader leaving.
    const upstream = new AbortController();
    const state = { readerLeft: false, streamFailed: false };
    res.on('close', () => {
      if (res.writableFinished || state.streamFailed) return;
      state.readerLeft = true;
      upstream.abort();
    });

    let target: URL;
    try {
      target = parseKlipyCdnUrl(rawUrl);
      await assertSafeExternalUrl(target.href);
    } catch (error) {
      if (error instanceof GifMediaRefusedError) return this.refuse(res, error);
      if (error instanceof BadRequestException) {
        return this.refuse(res, new GifMediaRefusedError('blocked-address', error.message));
      }
      // The DNS lookup itself failed: KLIPY's host said nothing, which is not the request's fault.
      return this.unreachable(res, new UpstreamUnreachableError('static.klipy.com', error));
    }

    const cacheKey = target.href;
    const cached = GifMediaController.cache.get(cacheKey);
    if (cached) return this.sendCached(res, cached, 'cache hit');

    // SINGLE-FLIGHT: an identical request already on its way from KLIPY is waited on rather than
    // repeated - forty readers opening the same GIF at once make one upstream fetch. Waited on ONCE:
    // a verdict KLIPY gave is shared; a GIF the cache did not keep (over the entry ceiling, no
    // declared length, failed, its reader left) releases every waiter to fetch IN PARALLEL, so the
    // Nth reader waits two fetch times at most, never N.
    const leader = GifMediaController.inFlight.get(cacheKey);
    if (leader) {
      const verdict = await leader;
      if (state.readerLeft) return this.readerGone('while an identical fetch was in flight');
      if (verdict) return this.refuse(res, verdict, 'shared with an identical fetch');
      const filled = GifMediaController.cache.get(cacheKey);
      if (filled) return this.sendCached(res, filled, 'served from an identical fetch');
    }

    if (GifMediaController.active >= GIF_MEDIA_MAX_IN_FLIGHT) {
      return this.refuse(
        res,
        new GifMediaRefusedError('busy', `${GIF_MEDIA_MAX_IN_FLIGHT} GIFs already on their way`)
      );
    }
    // A released waiter fetches beside the others and leads nobody; the first fetch of a key leads.
    const leads = !GifMediaController.inFlight.has(cacheKey);
    let release!: (verdict: GifMediaRefusedError | null) => void;
    if (leads) {
      GifMediaController.inFlight.set(
        cacheKey,
        new Promise<GifMediaRefusedError | null>((resolve) => (release = resolve))
      );
    }
    GifMediaController.active += 1;
    let verdict: GifMediaRefusedError | null = null;
    try {
      verdict = await this.fetchAndStream(res, target, upstream, state);
    } finally {
      GifMediaController.active -= 1;
      if (leads) {
        GifMediaController.inFlight.delete(cacheKey);
        release(verdict);
      }
    }
  }

  /**
   * The fetching half: asks KLIPY, judges the answer, streams it to `res`, and fills the cache when
   * the whole GIF was received, small enough, and exactly as long as KLIPY declared. The whole fetch
   * is bounded by `GIF_MEDIA_FETCH_DEADLINE_MS`. Returns the refusal it answered with before any
   * byte was sent - KLIPY's verdict on this GIF, which the waiters share - or `null`.
   */
  private async fetchAndStream(
    res: ExpressResponse,
    target: URL,
    upstream: AbortController,
    state: { readerLeft: boolean; streamFailed: boolean }
  ): Promise<GifMediaRefusedError | null> {
    const deadline = { passed: false };
    const timer = setTimeout(() => {
      deadline.passed = true;
      upstream.abort();
    }, GIF_MEDIA_FETCH_DEADLINE_MS);
    try {
      return await this.fetchWithin(res, target, upstream.signal, state, deadline);
    } finally {
      clearTimeout(timer);
    }
  }

  /** `fetchAndStream`'s body, with `deadline.passed` telling a timeout from every other abort. */
  private async fetchWithin(
    res: ExpressResponse,
    target: URL,
    signal: AbortSignal,
    state: { readerLeft: boolean; streamFailed: boolean },
    deadline: { passed: boolean }
  ): Promise<GifMediaRefusedError | null> {
    const cacheKey = target.href;
    const timedOut = (): GifMediaRefusedError =>
      new GifMediaRefusedError('timed-out', `${GIF_MEDIA_FETCH_DEADLINE_MS} ms`);
    let response: Awaited<ReturnType<typeof ssrfSafeFetch>>;
    try {
      response = await ssrfSafeFetch(target.href, {
        method: 'GET',
        // Refused rather than followed: the allowlist decided the HOST, and a redirect is another.
        redirect: 'manual',
        signal,
        // No header of the reader's: KLIPY learns this server and nothing else. `identity`: the
        // bytes counted and cached are the GIF's own, never a compressed transfer of them.
        headers: {
          'user-agent': 'CanariGifRelay/1.0',
          accept: 'image/gif',
          'accept-encoding': 'identity',
        },
      });
    } catch (error) {
      if (deadline.passed) {
        const refusal = timedOut();
        this.refuse(res, refusal, 'before KLIPY answered');
        return refusal;
      }
      if (state.readerLeft) {
        this.readerGone('before KLIPY answered');
        return null;
      }
      this.unreachable(res, new UpstreamUnreachableError(target.hostname, error));
      return null;
    }

    const refusal = this.judge(response);
    if (refusal) {
      // Free the socket: nobody will read this body.
      await response.body?.cancel().catch((error: unknown) => {
        this.logger.debug(`[GIF_MEDIA] cancelling a refused body failed: ${String(error)}`);
      });
      this.refuse(res, refusal);
      return refusal;
    }

    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const declaredLength = Number.isFinite(declared) ? declared : null;
    writeRelayedImageHeaders(res, {
      contentType: 'image/gif',
      length: declaredLength,
      cacheControl: GIF_CACHE_CONTROL,
    });

    const counter = new GifByteCounter(GIF_MEDIA_MAX_BYTES, GIF_MEDIA_CACHE_ENTRY_MAX_BYTES);
    try {
      // `judge` refused a null body, so it is a stream here. undici's ReadableStream is Node's.
      const source = Readable.fromWeb(
        response.body as unknown as NodeWebReadableStream<Uint8Array>
      );
      const markFailed = (): void => void (state.streamFailed = true);
      source.once('error', markFailed);
      counter.once('error', markFailed);
      await pipeline(source, counter, res);
    } catch (error) {
      // Headers are out: the only thing left to do with a failure is to say which one it was. The
      // pipeline has already destroyed the response, so the reader sees a cut-off image.
      if (error instanceof GifMediaRefusedError) {
        this.logger.warn(`[GIF_MEDIA] cut off mid-stream: ${error.message}`);
        return null;
      }
      if (deadline.passed) {
        this.logger.warn(
          `[GIF_MEDIA] cut off mid-stream: ${timedOut().message} after ${counter.received} bytes`
        );
        return null;
      }
      if (state.readerLeft) {
        this.readerGone(`after ${counter.received} bytes`);
        return null;
      }
      this.logger.warn(
        `[GIF_MEDIA] KLIPY's body failed after ${counter.received} bytes: ` +
          `${String(errorCause(error) ?? error)}`
      );
      return null;
    }

    // Kept only when it is provably the WHOLE GIF: KLIPY declared a length and that many bytes came.
    const body = counter.body();
    let outcome: string;
    if (!body) outcome = 'not cached: over the entry ceiling';
    else if (declaredLength === null) outcome = 'not cached: KLIPY declared no length';
    else if (body.length !== declaredLength) {
      outcome = `not cached: ${body.length} bytes for ${declaredLength} declared`;
    } else if (!GifMediaController.cache.set(cacheKey, body, GIF_MEDIA_TTL_MS)) {
      outcome = 'not cached: heavier than the whole cache';
    } else outcome = 'cached';
    this.logger.debug(`[GIF_MEDIA] relayed ${counter.received} bytes (${outcome})`);
    return null;
  }

  /** Answers from the byte cache - after a hit, or after an identical fetch filled it. */
  private sendCached(res: ExpressResponse, body: Buffer, how: string): void {
    this.logger.debug(`[GIF_MEDIA] ${how} (${body.length} bytes)`);
    writeRelayedImageHeaders(res, {
      contentType: 'image/gif',
      length: body.length,
      cacheControl: GIF_CACHE_CONTROL,
    });
    res.end(body);
  }

  /**
   * What KLIPY's answer, before its body, makes of the request: `null` when it is a GIF the relay
   * may stream, otherwise the typed refusal.
   */
  private judge(response: Awaited<ReturnType<typeof ssrfSafeFetch>>): GifMediaRefusedError | null {
    if (response.status >= 300 && response.status <= 399) {
      return new GifMediaRefusedError('redirected', `HTTP ${response.status}`);
    }
    if (response.status === 404) return new GifMediaRefusedError('upstream-not-found');
    if (!response.ok) return new GifMediaRefusedError('upstream-status', `HTTP ${response.status}`);
    const contentType = response.headers.get('content-type');
    if (!isGifContentType(contentType)) {
      return new GifMediaRefusedError('not-gif', contentType ?? 'no content-type');
    }
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > GIF_MEDIA_MAX_BYTES) {
      return new GifMediaRefusedError('too-large', `${declared} bytes declared`);
    }
    if (!response.body) return new GifMediaRefusedError('empty-body');
    return null;
  }

  /** A typed refusal: logged under its reason, answered with its status and no body. */
  private refuse(res: ExpressResponse, refusal: GifMediaRefusedError, how?: string): void {
    const context = how ? ` (${how})` : '';
    this.logger.warn(`[GIF_MEDIA] refused (${refusal.status}): ${refusal.message}${context}`);
    res.status(refusal.status).end();
  }

  /** KLIPY said nothing - not cached, not the request's fault: a 502. */
  private unreachable(res: ExpressResponse, error: UpstreamUnreachableError): void {
    this.logger.warn(`[GIF_MEDIA] ${error.message} (budget ${OUTBOUND_BUDGET_MS} ms per leg)`);
    res.status(502).end();
  }

  /** The reader went away: expected (a scroll, a closed conversation), so debug - but logged. */
  private readerGone(when: string): void {
    this.logger.debug(`[GIF_MEDIA] the reader left ${when}; KLIPY's request was abandoned`);
  }
}
