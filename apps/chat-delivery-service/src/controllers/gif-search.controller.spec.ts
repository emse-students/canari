/// <reference types="jest" />

/**
 * THE GIF SEARCH ROUTE: THE QUERY STAYS OURS, ONLY AN ANSWER IS CACHED, AND THE GUARDS RUN IN ORDER.
 *
 * Pinned: a malformed query or page is a 400 before KLIPY is asked; an estate without a key says so
 * as a 503; a KLIPY failure is a 502 and is NOT remembered; the query text never reaches a log line;
 * and the per-user throttler runs AFTER the guard that proves the user id it keys on.
 */
import {
  BadGatewayException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('../utils/klipy', () => {
  const actual = jest.requireActual('../utils/klipy');
  return { ...actual, fetchKlipyPage: jest.fn() };
});

import { GifSearchController } from './gif-search.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { KlipyHttpError, fetchKlipyPage } from '../utils/klipy';

const fetchMock = fetchKlipyPage as jest.MockedFunction<typeof fetchKlipyPage>;

const makeRes = () => {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (k: string, v: string) => void (headers[k] = v) } as never;
};

const PAGE = {
  page: {
    gifs: [
      {
        id: '1',
        preview: { url: 'https://static.klipy.com/a.gif', width: 2, height: 1 },
        full: { url: 'https://static.klipy.com/b.gif', width: 4, height: 2 },
      },
    ],
    hasNext: false,
  },
  received: 1,
  dropped: 0,
};

describe('GifSearchController', () => {
  const controller = new GifSearchController();
  const savedKey = process.env.KLIPY_API_KEY;
  let logged: string[];

  beforeEach(() => {
    process.env.KLIPY_API_KEY = 'server-key';
    GifSearchController.cache.clear();
    fetchMock.mockReset();
    logged = [];
    for (const level of ['log', 'debug', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.KLIPY_API_KEY = savedKey;
  });

  it('runs the user throttler AFTER the guard that proves the user id', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      Object.getOwnPropertyDescriptor(GifSearchController.prototype, 'search')?.value as object
    );
    expect(guards).toEqual([HeaderAuthGuard, UserThrottlerGuard]);
  });

  it('answers a search with the server key and never logs the query', async () => {
    fetchMock.mockResolvedValue(PAGE);
    const res = makeRes();
    const result = await controller.search('  secret words ', '2', res);
    expect(result).toEqual(PAGE.page);
    expect(fetchMock).toHaveBeenCalledWith('server-key', 'secret words', 2);
    expect((res as unknown as { headers: Record<string, string> }).headers['Cache-Control']).toBe(
      'private, max-age=300'
    );
    expect(logged.join('\n')).not.toContain('secret');
  });

  it('asks for trending page 1 when there is neither query nor page', async () => {
    fetchMock.mockResolvedValue(PAGE);
    await controller.search(undefined, undefined, makeRes());
    expect(fetchMock).toHaveBeenCalledWith('server-key', '', 1);
  });

  it('answers the second identical request from the cache', async () => {
    fetchMock.mockResolvedValue(PAGE);
    await controller.search('Chat', '1', makeRes());
    await controller.search('chat', '1', makeRes());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an array query', ['a', 'b'], '1'],
    ['a query over the cap', 'x'.repeat(101), '1'],
    ['page 0', 'a', '0'],
    ['a fractional page', 'a', '1.5'],
    ['a page past the cap', 'a', '51'],
    ['a non-numeric page', 'a', 'two'],
  ])('refuses %s with a 400 before asking KLIPY', async (_label, q, page) => {
    await expect(controller.search(q as string, page, makeRes())).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says 503 when the estate has no KLIPY key', async () => {
    delete process.env.KLIPY_API_KEY;
    await expect(controller.search('a', '1', makeRes())).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a KLIPY error to 502 and does NOT remember it', async () => {
    fetchMock.mockRejectedValueOnce(new KlipyHttpError(500)).mockResolvedValueOnce(PAGE);
    await expect(controller.search('a', '1', makeRes())).rejects.toBeInstanceOf(
      BadGatewayException
    );
    await expect(controller.search('a', '1', makeRes())).resolves.toEqual(PAGE.page);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a transport failure to 502 as well', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(controller.search('', '1', makeRes())).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('UserThrottlerGuard', () => {
  it('keys on the proven user id, not on the address nginx shares with everybody', async () => {
    const guard = Object.create(UserThrottlerGuard.prototype) as UserThrottlerGuard;
    const tracker = (
      guard as unknown as { getTracker: (r: unknown) => Promise<string> }
    ).getTracker.bind(guard);
    await expect(tracker({ ip: '172.18.0.2', headers: { 'x-user-id': ' ABC ' } })).resolves.toBe(
      'user:abc'
    );
    await expect(tracker({ ip: '172.18.0.2', headers: {} })).resolves.toBe('user:unidentified');
  });
});
