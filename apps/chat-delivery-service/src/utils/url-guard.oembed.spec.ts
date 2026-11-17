/// <reference types="jest" />

/**
 * THE OPTIONAL ENRICHMENT NEVER COSTS THE PREVIEW, AND NEVER FAILS SILENTLY. `fetchOEmbedData`
 * used to catch everything into `null`, so "the site has no usable oEmbed" and "we could not reach
 * it" and "the page pointed us at a private address" read the same - as nothing. Each failure is now
 * a typed {@link OEmbedUnavailable} whose kind the caller logs at the level it deserves.
 */
const lookup = jest.fn();
jest.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => lookup(...args) }));
const undiciFetch = jest.fn();
jest.mock('undici', () => ({
  ...jest.requireActual('undici'),
  fetch: (...args: unknown[]) => undiciFetch(...args),
}));

import { fetchOEmbedData, OEmbedUnavailable } from './url-guard';

const ENDPOINT = 'https://oembed.example/o?url=x';

/** A response with the given status, content type and body. */
const reply = (status: number, contentType: string, body: string) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Map([['content-type', contentType]]),
  text: async () => body,
});

describe('fetchOEmbedData - every failure is typed', () => {
  beforeEach(() => {
    lookup.mockReset();
    undiciFetch.mockReset();
    lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  });

  it('returns the fields of a usable answer', async () => {
    undiciFetch.mockResolvedValue(
      reply(200, 'application/json', JSON.stringify({ title: ' A title ', provider_name: 'Vimeo' }))
    );

    expect(await fetchOEmbedData(ENDPOINT)).toEqual({
      title: 'A title',
      authorName: undefined,
      thumbnailUrl: undefined,
      providerName: 'Vimeo',
    });
  });

  it('lets a bug of ours propagate rather than calling it an outage', async () => {
    const bug = new TypeError('a bug of ours');
    lookup.mockRejectedValue(bug);

    await expect(fetchOEmbedData(ENDPOINT)).rejects.toBe(bug);
  });

  it.each([
    ['refused', () => lookup.mockResolvedValue([{ address: '10.0.0.4', family: 4 }])],
    [
      'unreachable',
      () =>
        lookup.mockRejectedValue(
          Object.assign(new Error('getaddrinfo EAI_AGAIN'), {
            code: 'EAI_AGAIN',
            syscall: 'getaddrinfo',
          })
        ),
    ],
    [
      'unreachable',
      () =>
        undiciFetch.mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause: new Error('ConnectTimeoutError') })
        ),
    ],
    ['status', () => undiciFetch.mockResolvedValue(reply(404, 'application/json', '{}'))],
    ['not-json', () => undiciFetch.mockResolvedValue(reply(200, 'text/html', '<html>'))],
    ['malformed', () => undiciFetch.mockResolvedValue(reply(200, 'application/json', '{not json'))],
  ])('types a failure as %s, never as a bare null', async (kind, arrange) => {
    arrange();

    const outcome = await fetchOEmbedData(ENDPOINT);

    expect(outcome).toBeInstanceOf(OEmbedUnavailable);
    expect((outcome as OEmbedUnavailable).kind).toBe(kind);
    expect((outcome as OEmbedUnavailable).detail).not.toBe('');
  });
});
