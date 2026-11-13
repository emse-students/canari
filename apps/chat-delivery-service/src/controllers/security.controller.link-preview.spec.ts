/// <reference types="jest" />

/**
 * ONLY AN ANSWER MAY BE CACHED, AND ONLY AN ANSWER MAY BE A 400.
 *
 * The defect measured on 2026-08-15: one Wikipedia connect timeout was stored as a refusal and
 * replayed as `400` to every reader for ten minutes, for a page that answered normally six minutes
 * later (`cache hit ... ok=true` in the same log). Two things were wrong at once and they need
 * asserting together - the STATUS lied about whose fault it was, and the LIE was cached.
 *
 * Both cases go through the same endpoint with the same shape, so the only thing separating them is
 * the type thrown deep inside, which is exactly what this pins.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { ClientIpThrottlerGuard } from '../guards/client-ip-throttler.guard';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

jest.mock('../utils/url-guard', () => {
  const actual = jest.requireActual('../utils/url-guard');
  return {
    ...actual,
    // A NAME is accepted without the DNS lookup the real guard makes; a host written as an
    // ADDRESS, or another scheme, needs no lookup: those go to the real guard and are judged
    // as in production.
    assertSafeExternalUrl: jest.fn(async (u: string | URL) => {
      const parsed = new URL(String(u));
      const isAddress = /^[\d.]+$/.test(parsed.hostname) || parsed.hostname.startsWith('[');
      const isWeb = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      return isAddress || !isWeb ? actual.assertSafeExternalUrl(String(u)) : parsed;
    }),
    ssrfSafeFetch: jest.fn(),
    fetchYouTubeOEmbed: jest.fn(async () => null),
    fetchMiGalleryPreview: jest.fn(async () => null),
  };
});

import { SecurityController } from './security.controller';
import { assertSafeExternalUrl, ssrfSafeFetch } from '../utils/url-guard';
import { mintPreviewTicket } from '../utils/previewTicket';

const fetchMock = ssrfSafeFetch as jest.MockedFunction<typeof ssrfSafeFetch>;
const guardMock = assertSafeExternalUrl as jest.MockedFunction<typeof assertSafeExternalUrl>;

/** `@Res({ passthrough: true })` only ever has `setHeader` called on it here. */
const makeRes = () => {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (k: string, v: string) => void (headers[k] = v) };
};

/** A response the endpoint will refuse for a reason that IS an answer about the URL. */
const notHtml = () =>
  ({
    status: 200,
    ok: true,
    headers: new Map([['content-type', 'application/pdf']]) as unknown as Headers,
    text: async () => '',
  }) as never;

/** What a shortener answers: a hop, and nothing else. */
const redirectTo = (location: string) =>
  ({
    status: 301,
    ok: false,
    headers: new Map([['location', location]]) as unknown as Headers,
    text: async () => '',
  }) as never;

/** An HTML page whose Open Graph references are relative, as most sites write them. */
const htmlPage = () =>
  ({
    status: 200,
    ok: true,
    headers: new Map([['content-type', 'text/html; charset=utf-8']]) as unknown as Headers,
    text: async () =>
      '<html><head>' +
      '<meta property="og:title" content="An event">' +
      '<meta property="og:image" content="/files/event/150/1461421.jpg?v=1789050716">' +
      '<link rel="icon" href="/assets/icon.png">' +
      '</head></html>',
  }) as never;

describe('SecurityController - getLinkPreview classifies what it could not do', () => {
  let controller: SecurityController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SecurityController],
      providers: [
        { provide: getRepositoryToken(PinVerifier), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: {} },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ClientIpThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<SecurityController>(SecurityController);
  });

  it('answers 502 for an unreachable host, and does NOT remember it', async () => {
    const url = 'https://unreachable.example/a';
    // What undici actually raises when a connect times out: a bare TypeError carrying the reason.
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: new Error('ConnectTimeoutError') })
    );

    await expect(controller.getLinkPreview(url, makeRes() as never)).rejects.toBeInstanceOf(
      BadGatewayException
    );
    // THE SECOND CALL IS THE POINT. A cached transport failure would answer without asking again,
    // which is how one blip became ten minutes of a wrong answer for every reader.
    await expect(controller.getLinkPreview(url, makeRes() as never)).rejects.toBeInstanceOf(
      BadGatewayException
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const res = makeRes();
    await controller.getLinkPreview(url, res as never).catch(() => undefined);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('answers 400 for a page that IS an answer, and remembers that one', async () => {
    const url = 'https://answers.example/b.pdf';
    fetchMock.mockResolvedValue(notHtml());

    await expect(controller.getLinkPreview(url, makeRes() as never)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(controller.getLinkPreview(url, makeRes() as never)).rejects.toBeInstanceOf(
      BadRequestException
    );
    // Asked once: the refusal is a fact about this URL and re-downloading the page to rediscover it
    // is what the cache exists to stop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * A RELATIVE REFERENCE BELONGS TO THE PAGE THAT ANSWERED, NOT TO THE LINK THAT WAS WRITTEN.
   *
   * Measured on production 2026-09-23: a shortened link whose destination declares a relative
   * `og:image` produced `GET .../link-preview/image?url=https://bit.ly/files/event/150/1461421.jpg`
   * - a 404 the image proxy then cached, so the card stayed illustration-less for six hours. The
   * redirect chain was walked correctly and its result was thrown away at the last step.
   */
  it('resolves relative references against the page that answered, not the link that was written', async () => {
    const written = 'https://short.example/abc';
    fetchMock
      .mockResolvedValueOnce(redirectTo('https://events.example/e/150'))
      .mockResolvedValueOnce(htmlPage());

    const payload = await controller.getLinkPreview(written, makeRes() as never);

    expect(payload.image).toBe('https://events.example/files/event/150/1461421.jpg?v=1789050716');
    expect(payload.icon).toBe('https://events.example/assets/icon.png');
    // The identity of the link is NOT the base: this is what the card shows and opens, and it is
    // what the cache is keyed on.
    expect(payload.url).toBe(written);
  });

  it('keeps resolving against the link itself when nothing redirected', async () => {
    fetchMock.mockResolvedValueOnce(htmlPage());

    const payload = await controller.getLinkPreview(
      'https://events.example/direct',
      makeRes() as never
    );

    expect(payload.image).toBe('https://events.example/files/event/150/1461421.jpg?v=1789050716');
  });

  /**
   * THE IMAGE WALKS ITS REDIRECTS THE WAY THE PAGE DOES: every hop is judged before anything is
   * sent to it, and a hop that is not a public http(s) URL ends the walk.
   */
  describe('the image of a preview', () => {
    const SECRET = 'link-preview-test-secret';
    const savedSecret = process.env.INTERNAL_SHARED_SECRET;
    let ticket: string;

    beforeAll(() => {
      process.env.INTERNAL_SHARED_SECRET = SECRET;
      ticket = mintPreviewTicket(SECRET).ticket;
    });
    afterAll(() => {
      process.env.INTERNAL_SHARED_SECRET = savedSecret;
    });
    // An answer queued by one case and never asked for must not be served to the next.
    beforeEach(() => void fetchMock.mockReset());

    /** What the route writes: a status, headers, a body. */
    const makeImageRes = () => {
      const seen: { status: number; headers: Record<string, unknown>; body?: unknown } = {
        status: 200,
        headers: {},
      };
      const res = {
        status: (code: number) => ((seen.status = code), res),
        setHeader: (k: string, v: unknown) => void (seen.headers[k] = v),
        end: (body?: unknown) => void (seen.body = body),
      };
      return { seen, res };
    };

    const png = () =>
      ({
        status: 200,
        ok: true,
        headers: new Map([['content-type', 'image/png']]) as unknown as Headers,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }) as never;

    it('follows a hop to a public host and serves the image', async () => {
      fetchMock
        .mockResolvedValueOnce(redirectTo('https://cdn.example/a.png'))
        .mockResolvedValueOnce(png());
      const { seen, res } = makeImageRes();

      await controller.getLinkPreviewImage('https://img.example/a', ticket, res as never);

      expect(seen.status).toBe(200);
      expect(seen.headers['Content-Type']).toBe('image/png');
      expect(fetchMock.mock.calls.map(([target]) => target)).toEqual([
        'https://img.example/a',
        'https://cdn.example/a.png',
      ]);
      // Each leg is asked for one answer, never for a chain.
      for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('manual');
    });

    it.each([
      ['an IPv4 loopback address', 'http://127.0.0.1/a.png'],
      ['an IPv6 loopback address', 'http://[::1]/a.png'],
      ['another scheme', 'file:///etc/hostname'],
    ])('sends nothing to a hop that names %s, and answers 502', async (_what, hop) => {
      fetchMock.mockResolvedValueOnce(redirectTo(hop)).mockResolvedValueOnce(png());
      const { seen, res } = makeImageRes();

      await controller.getLinkPreviewImage('https://img.example/b', ticket, res as never);

      expect(seen.status).toBe(502);
      expect(seen.body).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // It is the guard that refused the hop, not a fetch that happened to fail: the hop was
      // handed to it, and its answer was a refusal.
      const hopCheck = guardMock.mock.calls.findIndex(([asked]) => String(asked) === hop);
      expect(hopCheck).toBeGreaterThan(-1);
      await expect(guardMock.mock.results[hopCheck].value).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('cancels the body of each redirect it follows', async () => {
      const cancel = jest.fn(async () => undefined);
      const hop = { ...(redirectTo('https://cdn.example/a.png') as object), body: { cancel } };
      fetchMock.mockResolvedValueOnce(hop as never).mockResolvedValueOnce(png());
      const { seen, res } = makeImageRes();

      await controller.getLinkPreviewImage('https://img.example/d', ticket, res as never);

      expect(seen.status).toBe(200);
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('stops after five redirects', async () => {
      fetchMock.mockResolvedValue(redirectTo('https://img.example/again'));
      const { seen, res } = makeImageRes();

      await controller.getLinkPreviewImage('https://img.example/c', ticket, res as never);

      expect(seen.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });
  });
});
