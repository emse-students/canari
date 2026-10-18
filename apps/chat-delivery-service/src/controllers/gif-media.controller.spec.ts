/// <reference types="jest" />

/**
 * THE GIF RELAY: A TICKET, ONE HOST, A GIF UNDER ITS CEILING, STREAMED, CACHED ONCE.
 *
 * Pinned: no ticket is a 401 before anything else; a URL off KLIPY's CDN is refused before any
 * fetch; KLIPY is asked with no header of the reader's and with redirects refused; the bytes reach
 * the reader with `nosniff` and a private cache header, and a second reader is answered from the
 * byte cache; a GIF over the entry ceiling streams but is not kept; every refusal (declared too
 * large, cut off mid-stream, not a GIF, redirected, 404, unreachable) has its status and its log
 * line, and none is cached.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { PassThrough } from 'node:stream';

jest.mock('../utils/url-guard', () => {
  const actual = jest.requireActual('../utils/url-guard');
  return { ...actual, ssrfSafeFetch: jest.fn(), assertSafeExternalUrl: jest.fn() };
});

import { GifMediaController } from './gif-media.controller';
import { assertSafeExternalUrl, ssrfSafeFetch } from '../utils/url-guard';
import { mintGifMediaTicket, mintPreviewTicket } from '../utils/previewTicket';
import { GIF_MEDIA_CACHE_ENTRY_MAX_BYTES, GIF_MEDIA_MAX_BYTES } from '../utils/gif-media';

const fetchMock = ssrfSafeFetch as jest.MockedFunction<typeof ssrfSafeFetch>;
const guardMock = assertSafeExternalUrl as jest.MockedFunction<typeof assertSafeExternalUrl>;

const SECRET = 'gif-relay-test-secret';
const GIF_URL = 'https://static.klipy.com/ii/abc/de/f.gif';
const GIF89A = Buffer.from('GIF89a-some-frames');

/** An Express response stand-in: a real stream (the relay pipes into it) with the setters it uses. */
function makeRes() {
  const sink = new PassThrough();
  const received: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => received.push(chunk));
  const headers: Record<string, unknown> = {};
  const res = Object.assign(sink, {
    statusCode: 200,
    setHeader: (k: string, v: unknown) => void (headers[k.toLowerCase()] = v),
    status: (code: number) => {
      res.statusCode = code;
      return res;
    },
  });
  return { res, headers, body: () => Buffer.concat(received) };
}

/** What KLIPY answers, as the fetch the relay uses returns it. */
function upstream(
  body: Buffer | null,
  init: { status?: number; headers?: Record<string, string> }
) {
  return new Response(body === null ? null : new Uint8Array(body), {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  }) as unknown as Awaited<ReturnType<typeof ssrfSafeFetch>>;
}

const gifAnswer = (body: Buffer = GIF89A, extra: Record<string, string> = {}) =>
  upstream(body, {
    headers: { 'content-type': 'image/gif', 'content-length': String(body.length), ...extra },
  });

describe('GifMediaController', () => {
  const controller = new GifMediaController();
  const savedSecret = process.env.INTERNAL_SHARED_SECRET;
  let logged: string[];
  let ticket: string;

  beforeEach(() => {
    process.env.INTERNAL_SHARED_SECRET = SECRET;
    ticket = mintGifMediaTicket(SECRET).ticket;
    GifMediaController.cache.clear();
    fetchMock.mockReset();
    guardMock.mockReset();
    guardMock.mockImplementation(async (raw: string) => new URL(raw));
    logged = [];
    for (const level of ['log', 'debug', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.INTERNAL_SHARED_SECRET = savedSecret;
  });

  it('refuses without a GIF ticket - and a link-preview ticket is not one', async () => {
    for (const t of [undefined, 'nope', mintPreviewTicket(SECRET).ticket]) {
      const { res } = makeRes();
      await controller.relay(GIF_URL, t, res as never);
      expect(res.statusCode).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.some((l) => l.includes('no valid ticket'))).toBe(true);
  });

  it('refuses a URL off the CDN before any fetch, under its reason', async () => {
    const cases: [string, number, string][] = [
      ['https://media.giphy.com/a.gif', 400, 'host-not-allowed'],
      ['http://static.klipy.com/a.gif', 400, 'not-https'],
      ['https://static.klipy.com:444/a.gif', 400, 'non-default-port'],
    ];
    for (const [url, status, reason] of cases) {
      const { res } = makeRes();
      await controller.relay(url, ticket, res as never);
      expect(res.statusCode).toBe(status);
      expect(logged.some((l) => l.includes(reason))).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when the SSRF guard does (an address that is not public)', async () => {
    guardMock.mockRejectedValue(new BadRequestException('Private network URLs are not allowed'));
    const { res } = makeRes();
    await controller.relay(GIF_URL, ticket, res as never);
    expect(res.statusCode).toBe(400);
    expect(logged.some((l) => l.includes('blocked-address'))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('relays the GIF with its headers, asks KLIPY nothing of the reader, and caches it', async () => {
    fetchMock.mockResolvedValueOnce(gifAnswer());
    const first = makeRes();
    await controller.relay(`${GIF_URL}#cn-size=498x280`, ticket, first.res as never);

    expect(first.body().equals(GIF89A)).toBe(true);
    expect(first.headers['content-type']).toBe('image/gif');
    expect(first.headers['content-length']).toBe(GIF89A.length);
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.headers['cache-control']).toBe('private, max-age=86400');

    const [askedUrl, init] = fetchMock.mock.calls[0];
    // The fragment is the sender's, never KLIPY's, and never a second cache entry.
    expect(askedUrl).toBe(GIF_URL);
    expect(init?.redirect).toBe('manual');
    expect(Object.keys(init?.headers ?? {}).sort()).toEqual(['accept', 'user-agent']);

    // A second reader - with or without the fragment - is answered from the byte cache.
    const second = makeRes();
    await controller.relay(GIF_URL, ticket, second.res as never);
    expect(second.body().equals(GIF89A)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams a GIF over the cache entry ceiling but does not keep it', async () => {
    const big = Buffer.alloc(GIF_MEDIA_CACHE_ENTRY_MAX_BYTES + 1, 7);
    fetchMock.mockResolvedValueOnce(gifAnswer(big)).mockResolvedValueOnce(gifAnswer(big));
    const first = makeRes();
    await controller.relay(GIF_URL, ticket, first.res as never);
    expect(first.body().length).toBe(big.length);
    expect(GifMediaController.cache.size).toBe(0);

    const second = makeRes();
    await controller.relay(GIF_URL, ticket, second.res as never);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a GIF DECLARED over the ceiling without reading it (413)', async () => {
    const answer = upstream(Buffer.from('x'), {
      headers: { 'content-type': 'image/gif', 'content-length': String(GIF_MEDIA_MAX_BYTES + 1) },
    });
    const cancel = jest.spyOn(answer.body!, 'cancel');
    fetchMock.mockResolvedValueOnce(answer);
    const { res } = makeRes();
    await controller.relay(GIF_URL, ticket, res as never);
    expect(res.statusCode).toBe(413);
    expect(cancel).toHaveBeenCalled();
    expect(logged.some((l) => l.includes('too-large'))).toBe(true);
  });

  it('cuts off a GIF that streams past the ceiling with no declared length, and keeps nothing', async () => {
    const over = Buffer.alloc(GIF_MEDIA_MAX_BYTES + 1, 1);
    fetchMock.mockResolvedValueOnce(upstream(over, { headers: { 'content-type': 'image/gif' } }));
    const { res, body } = makeRes();
    await controller.relay(GIF_URL, ticket, res as never);
    expect(body().length).toBeLessThanOrEqual(GIF_MEDIA_MAX_BYTES);
    expect(res.destroyed).toBe(true);
    expect(GifMediaController.cache.size).toBe(0);
    expect(logged.some((l) => l.includes('cut off mid-stream') && l.includes('too-large'))).toBe(
      true
    );
    // It is the relay's refusal, not a reader leaving.
    expect(logged.some((l) => l.includes('the reader left'))).toBe(false);
  });

  it.each([
    [
      'not a GIF',
      upstream(Buffer.from('x'), { headers: { 'content-type': 'image/webp' } }),
      415,
      'not-gif',
    ],
    [
      'a redirect',
      upstream(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
      502,
      'redirected',
    ],
    ['a 404', upstream(null, { status: 404 }), 404, 'upstream-not-found'],
    ['a 500', upstream(null, { status: 500 }), 502, 'upstream-status'],
  ])(
    'answers %s with its own status and log line, and caches nothing',
    async (_what, answer, status, reason) => {
      fetchMock.mockResolvedValueOnce(answer);
      const { res } = makeRes();
      await controller.relay(GIF_URL, ticket, res as never);
      expect(res.statusCode).toBe(status);
      expect(logged.some((l) => l.includes(reason))).toBe(true);
      expect(GifMediaController.cache.size).toBe(0);
    }
  );

  it('is a 502 when KLIPY cannot be reached, logged as such', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { res } = makeRes();
    await controller.relay(GIF_URL, ticket, res as never);
    expect(res.statusCode).toBe(502);
    expect(logged.some((l) => l.includes('unreachable'))).toBe(true);
  });
});
