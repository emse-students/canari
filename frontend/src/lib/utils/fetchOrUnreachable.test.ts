/**
 * A STATUS CODE IS AN ANSWER, A TRANSPORT FAILURE IS NOT - and only one of them may reach the user
 * in the browser's own words.
 *
 * The three PIN calls in `sessionAuth.ts` each handled `!res.ok` with a Paraglide sentence and let a
 * REJECTED `fetch` walk past to the outer catch, whose message becomes the text in the modal. So a
 * person at the encryption gate with no network was shown `Failed to fetch`: untranslated, on a
 * screen whose every other word is French, and reading exactly like "your PIN is wrong".
 *
 * Measured by `pinrows.mjs --row 8` on 2026-09-05 with the network cut under the client -
 * `refusal: "Failed to fetch"` - on a row whose own question (does a dead radio end the session?)
 * answered PASS. It took a check that reads what the product SAID and not only what it did.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchOrUnreachable } from './fetchOrUnreachable';

const UNREACHABLE = 'Impossible de verifier le PIN (serveur injoignable).';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Silences the diagnostic line so a passing run is quiet, and hands back what it was told. */
const warned = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('fetchOrUnreachable', () => {
  it('replaces a rejected fetch with the caller sentence, and never leaks the raw one', async () => {
    warned();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(fetchOrUnreachable('https://x/api', {}, UNREACHABLE)).rejects.toThrow(UNREACHABLE);
  });

  it('says which host could not be reached, in the console where a developer looks', async () => {
    const warn = warned();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await fetchOrUnreachable('https://x/api/mls/security/pin-check', {}, UNREACHABLE).catch(
      () => null
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('/api/mls/security/pin-check');
  });

  it('keeps a query string out of that line - a salt url carries a user id', async () => {
    const warn = warned();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await fetchOrUnreachable('https://x/api/thing?userId=abcdef', {}, UNREACHABLE).catch(
      () => null
    );

    expect(String(warn.mock.calls[0][0])).not.toContain('abcdef');
  });

  it('passes a BAD ANSWER straight through, which is the half that must not drift', async () => {
    // A 500 is an answer. It belongs to the `!res.ok` branch at the call site, and a wrapper that
    // started turning it into "server unreachable" would erase the distinction it exists to draw.
    const res = new Response('nope', { status: 500 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    await expect(fetchOrUnreachable('https://x/api', {}, UNREACHABLE)).resolves.toBe(res);
  });

  it('passes a good answer through untouched, and hands `init` on as given', async () => {
    const res = new Response('{}', { status: 200 });
    const spy = vi.fn().mockResolvedValue(res);
    vi.stubGlobal('fetch', spy);
    const init = { method: 'POST', body: 'x' };

    await expect(fetchOrUnreachable('https://x/api', init, UNREACHABLE)).resolves.toBe(res);
    expect(spy).toHaveBeenCalledWith('https://x/api', init);
  });

  it('logs nothing when the request got an answer, however bad', async () => {
    const warn = warned();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    await fetchOrUnreachable('https://x/api', {}, UNREACHABLE);

    expect(warn).not.toHaveBeenCalled();
  });
});
