import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('$lib/seo/internalApi', () => ({
  SOCIAL_URL: () => 'http://social',
  fetchJson: (...args: unknown[]) => fetchJson(...args),
}));

import { GET } from './+server';

/**
 * THE SITEMAP ADVERTISES NO POST (owner, 2026-11-02). The anonymous listing of recent posts it read
 * was closed: without an account Canari shows nothing the public showcase does not, and a single
 * shared post's preview is the one exception kept (docs/wiki/anonymous-surface.md).
 */
describe('sitemap.xml', () => {
  beforeEach(() => fetchJson.mockReset());

  it('reads the public association projection and nothing else, and lists no post', async () => {
    fetchJson.mockResolvedValue([{ slug: 'bde', archived: false }]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await (GET as unknown as () => Promise<Response>)();
    const xml = await res.text();
    log.mockRestore();

    expect(fetchJson.mock.calls.map((c) => c[0])).toEqual([
      'http://social/api/public/associations',
    ]);
    expect(xml).toContain('/associations/bde</loc>');
    expect(xml).not.toMatch(/\/posts\/[^<]+<\/loc>/);
  });
});
