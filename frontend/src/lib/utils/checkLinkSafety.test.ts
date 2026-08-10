import { beforeEach, describe, expect, it, vi } from 'vitest';

const showConfirmMock = vi.fn();
vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: showConfirmMock,
}));

import { checkLinkSafety, confirmUnsafeLinkIfNeeded } from './checkLinkSafety';

const fetchMock = vi.fn();

beforeEach(async () => {
  fetchMock.mockReset();
  showConfirmMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // Each test gets a fresh href so the module-level dedup cache never leaks between cases.
});

describe('checkLinkSafety', () => {
  it('returns true when the server flags the URL', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unsafe: true }), { status: 200 }));

    expect(await checkLinkSafety('https://evil.example.com/1')).toBe(true);
  });

  it('returns false when the server does not flag the URL', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unsafe: false }), { status: 200 }));

    expect(await checkLinkSafety('https://example.com/2')).toBe(false);
  });

  it('fails open on a non-ok response', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));

    expect(await checkLinkSafety('https://example.com/3')).toBe(false);
  });

  it('fails open when the request throws', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await checkLinkSafety('https://example.com/4')).toBe(false);
  });

  it('does not cache a failure, so a blip does not disable the check for the page lifetime', async () => {
    const href = 'https://example.com/4b';
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await checkLinkSafety(href)).toBe(false);

    // The page may live for days on mobile. A cached failure would answer "safe" for that whole
    // time; only a real verdict may be reused.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unsafe: true }), { status: 200 }));
    expect(await checkLinkSafety(href)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a non-ok response either', async () => {
    const href = 'https://example.com/4c';
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await checkLinkSafety(href)).toBe(false);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unsafe: true }), { status: 200 }));
    expect(await checkLinkSafety(href)).toBe(true);
  });

  it('dedupes concurrent calls for the same URL into a single request', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unsafe: false }), { status: 200 }));

    const href = 'https://example.com/5';
    const [a, b] = await Promise.all([checkLinkSafety(href), checkLinkSafety(href)]);

    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('confirmUnsafeLinkIfNeeded', () => {
  it('resolves true without prompting when the link is not flagged', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unsafe: false }), { status: 200 }));

    expect(await confirmUnsafeLinkIfNeeded('https://example.com/6')).toBe(true);
    expect(showConfirmMock).not.toHaveBeenCalled();
  });

  it('prompts and returns the user choice when the link is flagged', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unsafe: true }), { status: 200 }));
    showConfirmMock.mockResolvedValue(true);

    const result = await confirmUnsafeLinkIfNeeded('https://evil.example.com/7');

    expect(result).toBe(true);
    expect(showConfirmMock).toHaveBeenCalledTimes(1);
    expect(showConfirmMock.mock.calls[0][1]).toMatchObject({ danger: true });
  });

  it('returns false when the user cancels', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unsafe: true }), { status: 200 }));
    showConfirmMock.mockResolvedValue(false);

    expect(await confirmUnsafeLinkIfNeeded('https://evil.example.com/8')).toBe(false);
  });
});
