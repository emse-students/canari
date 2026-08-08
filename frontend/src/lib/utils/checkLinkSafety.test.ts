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
