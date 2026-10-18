import { BadRequestException, Controller, Get, Logger, Query, Res } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import {
  GIF_MEDIA_CACHE_ENTRY_MAX_BYTES,
  GIF_MEDIA_CACHE_MAX_BYTES,
  GIF_MEDIA_MAX_BYTES,
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
 * - Every refusal is typed (`GifMediaRefusedError`) and logged under its reason. Refusals are
 *   BODYLESS, like the preview proxy's: the answer is decoded by an `<img>`.
 * [chat](../../../../docs/wiki/frontend/modules/chat.md)
 */
@Controller()
export class GifMediaController {
  private readonly logger = new Logger(GifMediaController.name);

  /**
   * Keyed on the content URL (fragment dropped), shared by every reader: a GIF sent to a group of
   * forty is fetched from KLIPY once. Bounded in bytes as well as in entries.
   */
  static readonly cache = new TtlCache<Buffer>(500, {
    maxWeight: GIF_MEDIA_CACHE_MAX_BYTES,
    weigh: (body) => body.length,
  });

  /**
   * Relays one KLIPY GIF. 401 without a valid ticket; 400 for a URL the allowlist refuses; 404 when
   * KLIPY has no such GIF; 413 over the ceiling; 415 when KLIPY answers something that is not a GIF;
   * 502 when KLIPY redirected, failed or could not be reached.
   */
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
    let readerLeft = false;
    let streamFailed = false;
    res.on('close', () => {
      if (res.writableFinished || streamFailed) return;
      readerLeft = true;
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
    if (cached) {
      this.logger.debug(`[GIF_MEDIA] cache hit (${cached.length} bytes)`);
      writeRelayedImageHeaders(res, {
        contentType: 'image/gif',
        length: cached.length,
        cacheControl: GIF_CACHE_CONTROL,
      });
      res.end(cached);
      return;
    }

    let response: Awaited<ReturnType<typeof ssrfSafeFetch>>;
    try {
      response = await ssrfSafeFetch(target.href, {
        method: 'GET',
        // Refused rather than followed: the allowlist decided the HOST, and a redirect is another.
        redirect: 'manual',
        signal: upstream.signal,
        // No header of the reader's: KLIPY learns this server and nothing else.
        headers: { 'user-agent': 'CanariGifRelay/1.0', accept: 'image/gif' },
      });
    } catch (error) {
      if (readerLeft) return this.readerGone('before KLIPY answered');
      return this.unreachable(res, new UpstreamUnreachableError(target.hostname, error));
    }

    const refusal = this.judge(response);
    if (refusal) {
      // Free the socket: nobody will read this body.
      await response.body?.cancel().catch((error: unknown) => {
        this.logger.debug(`[GIF_MEDIA] cancelling a refused body failed: ${String(error)}`);
      });
      return this.refuse(res, refusal);
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
      const markFailed = (): void => void (streamFailed = true);
      source.once('error', markFailed);
      counter.once('error', markFailed);
      await pipeline(source, counter, res);
    } catch (error) {
      // Headers are out: the only thing left to do with a failure is to say which one it was. The
      // pipeline has already destroyed the response, so the reader sees a cut-off image.
      if (error instanceof GifMediaRefusedError) {
        this.logger.warn(`[GIF_MEDIA] cut off mid-stream: ${error.message}`);
        return;
      }
      if (readerLeft) return this.readerGone(`after ${counter.received} bytes`);
      this.logger.warn(
        `[GIF_MEDIA] KLIPY's body failed after ${counter.received} bytes: ` +
          `${String(errorCause(error) ?? error)}`
      );
      return;
    }

    const body = counter.body();
    if (body && (declaredLength === null || body.length === declaredLength)) {
      GifMediaController.cache.set(cacheKey, body, GIF_MEDIA_TTL_MS);
    }
    this.logger.debug(
      `[GIF_MEDIA] relayed ${counter.received} bytes (${body ? 'cached' : 'not cached: over the entry ceiling'})`
    );
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
  private refuse(res: ExpressResponse, refusal: GifMediaRefusedError): void {
    this.logger.warn(`[GIF_MEDIA] refused (${refusal.status}): ${refusal.message}`);
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
