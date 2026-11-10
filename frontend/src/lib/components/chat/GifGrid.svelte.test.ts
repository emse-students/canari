// @vitest-environment happy-dom
/**
 * KLIPY MAY REPEAT AN ITEM ACROSS TWO PAGES, and the grid keys its tiles by id: appended as they came,
 * page 2 crashed the chat page with Svelte's `each_key_duplicate` (production, 2026-11-09). The grid
 * merges pages by id, so the repeat is dropped and nothing throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import GifGrid from './GifGrid.svelte';
import { clearGifPageCache } from '$lib/utils/chat/gifSearchCache';

const gif = (id: string) => ({
  id,
  preview: { url: `https://static.klipy.com/${id}-s.gif`, width: 200, height: 100 },
  full: { url: `https://g/${id}-m.gif`, width: 498, height: 249 },
});
const pages = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('$lib/utils/chat/gifSearch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/gifSearch')>()),
  fetchGifPage: pages.fetch,
  GifSearchUnavailableError: class extends Error {},
}));
vi.mock('$lib/utils/previewTicket.svelte', () => ({
  ensurePreviewTicket: async () => {},
  previewTicket: () => 'preview-ticket',
  gifMediaTicket: () => 'gif-ticket',
}));

const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};

describe('GifGrid pagination', () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    clearGifPageCache();
    pages.fetch.mockReset();
    target = document.createElement('div');
    document.body.appendChild(target);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(206);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(2000);
  });
  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target.remove();
    vi.restoreAllMocks();
  });

  it('drops a result repeated by page 2 and does not crash', async () => {
    pages.fetch.mockImplementation(async (_q: string, page: number) =>
      page === 1
        ? { gifs: [gif('a'), gif('b')], hasNext: true }
        : { gifs: [gif('b'), gif('c')], hasNext: false }
    );
    app = mount(GifGrid, { target, props: { active: true, onPick: () => {} } });
    await settle();
    expect(pages.fetch).toHaveBeenCalledWith('', 2, expect.anything());
    const labels = target.querySelectorAll('[data-testid="gif-grid-scroller"] button');
    expect(labels).toHaveLength(3);
  });
});
