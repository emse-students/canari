import { beforeEach, describe, expect, it, vi } from 'vitest';

const showConfirmMock = vi.fn();
vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: showConfirmMock,
}));

/**
 * `apiFetch`, not the global `fetch`, and that is the point of the seam.
 *
 * `mls/link-safety` sits behind a guard since 2026-09-10, and nginx's `auth_request` identifies a
 * caller from the `Authorization` header alone - a bare same-origin `fetch` reaches it as nobody
 * and spends Canari's Safe Browsing quota for whoever asked. Mocking at this boundary is also what
 * keeps these cases about the caching rules below rather than about token refresh.
 */
const apiFetchMock = vi.fn();
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { checkLinkSafety, confirmUnsafeLinkIfNeeded } from './checkLinkSafety';

/** A fresh answer per call - a `Response` body may be read once, and these tests read several. */
function verdict(unsafe: boolean) {
  return () => new Response(JSON.stringify({ unsafe }), { status: 200 });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  showConfirmMock.mockReset();
  // Each test gets a fresh href so the module-level dedup cache never leaks between cases.
});

describe('checkLinkSafety', () => {
  it('asks through the authenticated wrapper, not a bare fetch', async () => {
    apiFetchMock.mockImplementation(verdict(false));

    await checkLinkSafety('https://example.com/0');

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toContain('/api/mls/link-safety?url=');
  });

  it('returns true when the server flags the URL', async () => {
    apiFetchMock.mockImplementation(verdict(true));

    expect(await checkLinkSafety('https://evil.example.com/1')).toBe(true);
  });

  it('returns false when the server does not flag the URL', async () => {
    apiFetchMock.mockImplementation(verdict(false));

    expect(await checkLinkSafety('https://example.com/2')).toBe(false);
  });

  it('fails open on a non-ok response', async () => {
    apiFetchMock.mockImplementation(() => new Response('', { status: 500 }));

    expect(await checkLinkSafety('https://example.com/3')).toBe(false);
  });

  it('fails open when the request throws', async () => {
    apiFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await checkLinkSafety('https://example.com/4')).toBe(false);
  });

  it('does not cache a failure, so a blip does not disable the check for the page lifetime', async () => {
    const href = 'https://example.com/4b';
    apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await checkLinkSafety(href)).toBe(false);

    // The page may live for days on mobile. A cached failure would answer "safe" for that whole
    // time; only a real verdict may be reused.
    apiFetchMock.mockImplementation(verdict(true));
    expect(await checkLinkSafety(href)).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a non-ok response either', async () => {
    const href = 'https://example.com/4c';
    apiFetchMock.mockImplementationOnce(() => new Response('', { status: 503 }));
    expect(await checkLinkSafety(href)).toBe(false);

    apiFetchMock.mockImplementation(verdict(true));
    expect(await checkLinkSafety(href)).toBe(true);
  });

  it('dedupes concurrent calls for the same URL into a single request', async () => {
    apiFetchMock.mockImplementation(verdict(false));

    const href = 'https://example.com/5';
    const [a, b] = await Promise.all([checkLinkSafety(href), checkLinkSafety(href)]);

    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('confirmUnsafeLinkIfNeeded', () => {
  it('resolves true without prompting when the link is not flagged', async () => {
    apiFetchMock.mockImplementation(verdict(false));

    expect(await confirmUnsafeLinkIfNeeded('https://example.com/6')).toBe(true);
    expect(showConfirmMock).not.toHaveBeenCalled();
  });

  it('prompts and returns the user choice when the link is flagged', async () => {
    apiFetchMock.mockImplementation(verdict(true));
    showConfirmMock.mockResolvedValue(true);

    const result = await confirmUnsafeLinkIfNeeded('https://evil.example.com/7');

    expect(result).toBe(true);
    expect(showConfirmMock).toHaveBeenCalledTimes(1);
    expect(showConfirmMock.mock.calls[0][1]).toMatchObject({ danger: true });
  });

  it('returns false when the user cancels', async () => {
    apiFetchMock.mockImplementation(verdict(true));
    showConfirmMock.mockResolvedValue(false);

    expect(await confirmUnsafeLinkIfNeeded('https://evil.example.com/8')).toBe(false);
  });
});
