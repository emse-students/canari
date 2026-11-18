/// <reference types="jest" />

/**
 * The SSRF guard's own DNS lookup, CLASSIFIED AT THE THROW. A name that does not exist is an answer
 * about the URL (`400`); a resolver that said nothing (`EAI_AGAIN`) is the same class as a connect
 * timeout ({@link UpstreamUnreachableError}). Before, both escaped raw - the error Bun's resolver
 * throws (`DNSException: getaddrinfo EAI_AGAIN`, no host in it) - and every route answered `500`.
 */
import { BadRequestException } from '@nestjs/common';

const lookup = jest.fn();
jest.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => lookup(...args) }));

import { assertSafeExternalUrl, UpstreamUnreachableError } from './url-guard';

/** What the resolver throws: an `Error` carrying the getaddrinfo code. */
const dnsError = (code: string) =>
  Object.assign(new Error(`getaddrinfo ${code}`), { code, syscall: 'getaddrinfo' });

describe('assertSafeExternalUrl - the DNS lookup', () => {
  beforeEach(() => lookup.mockReset());

  it('types EAI_AGAIN as unreachable, naming the host and the code', async () => {
    lookup.mockRejectedValue(dnsError('EAI_AGAIN'));

    const thrown = await assertSafeExternalUrl('https://silent.example/a').catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(UpstreamUnreachableError);
    const unreachable = thrown as UpstreamUnreachableError;
    expect(unreachable.host).toBe('silent.example');
    expect(unreachable.dnsCode).toBe('EAI_AGAIN');
    expect(unreachable.message).toContain('silent.example unreachable (dns EAI_AGAIN)');
  });

  it.each(['ENOTFOUND', 'ENODATA'])(
    "answers %s as the caller's 400: the name has no address",
    async (code) => {
      lookup.mockRejectedValue(dnsError(code));

      await expect(assertSafeExternalUrl('https://nowhere.example/a')).rejects.toBeInstanceOf(
        BadRequestException
      );
    }
  );

  it.each([
    ['a TypeError', new TypeError('a bug of ours')],
    ['a code with no getaddrinfo syscall', Object.assign(new Error('x'), { code: 'EAI_AGAIN' })],
  ])("rethrows %s untouched: only the resolver's own failure is classified", async (_what, bug) => {
    lookup.mockRejectedValue(bug);

    await expect(assertSafeExternalUrl('https://bug.example/a')).rejects.toBe(bug);
  });

  it('still refuses a name resolving to a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.4', family: 4 }]);

    await expect(assertSafeExternalUrl('https://inside.example/a')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('accepts a name resolving to a public address', async () => {
    lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);

    const url = await assertSafeExternalUrl('https://public.example/a');

    expect(url.hostname).toBe('public.example');
  });
});
