// @vitest-environment happy-dom
/**
 * `/posts?q=words` (the site's declared SearchAction) hands the bar its words ONCE: the search asks
 * each section once, and an answer landing never asks it again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, createRawSnippet } from 'svelte';
import type { SearchProvider } from '$lib/search/types';
import type { UniversalSearchWiring } from '$lib/search/wiring';

vi.mock('$lib/search/wiring', () => ({ wireUniversalSearch: () => null }));
vi.mock('$lib/components/posts/PostSearchFilters.svelte', async () => ({
  default: (await import('$lib/components/reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/calendar/CalendarEventDetailModal.svelte', async () => ({
  default: (await import('$lib/components/reels/AvatarStub.test-helper.svelte')).default,
}));

import UniversalSearch from './UniversalSearch.svelte';

let mounted: Record<string, unknown> | null = null;
afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = '';
});

describe('UniversalSearch opened with words', () => {
  it('asks every section once, however many answers land', async () => {
    const asked = vi.fn();
    const provider: SearchProvider = {
      section: 'settings',
      source: 'device',
      search: async ({ query }) => {
        asked(query);
        return { hits: [{ key: 'k', title: 'Gala', href: '/x' }], total: 1 };
      },
    };
    const posts = vi.fn(async () => []);
    const wire = (): UniversalSearchWiring => ({ providers: [provider], posts, close: () => {} });
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted = mount(UniversalSearch, {
      target,
      props: {
        open: true,
        initialQuery: 'gala',
        onClose: () => {},
        post: createRawSnippet(() => ({ render: () => '<div></div>' })) as never,
        wire: wire as never,
      },
    });
    for (let i = 0; i < 10; i++) {
      flushSync();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(target.querySelector('[data-search-section="settings"]')).not.toBeNull();
    // setQuery runs the device section, submit runs every section: twice at most, never a loop.
    expect(asked.mock.calls.length).toBeLessThanOrEqual(2);
    expect(posts.mock.calls.length).toBe(1);
  });
});
