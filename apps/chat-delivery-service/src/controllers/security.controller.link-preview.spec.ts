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
    // The SSRF guard is not what is under test here; it answers for any public URL.
    assertSafeExternalUrl: jest.fn(async (u: string | URL) => new URL(String(u))),
    ssrfSafeFetch: jest.fn(),
    fetchYouTubeOEmbed: jest.fn(async () => null),
    fetchMiGalleryPreview: jest.fn(async () => null),
  };
});

import { SecurityController } from './security.controller';
import { ssrfSafeFetch } from '../utils/url-guard';

const fetchMock = ssrfSafeFetch as jest.MockedFunction<typeof ssrfSafeFetch>;

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
});
