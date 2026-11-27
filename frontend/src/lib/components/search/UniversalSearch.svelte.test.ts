// @vitest-environment happy-dom
/**
 * The search page as a reader meets it: one bar, the sections that found something with their top
 * 3, a chip per section, "Tout afficher" opening the rest, the Posts section's filters, the arrow
 * keys walking the results, and the search dropped - its message index with it - when it closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { PostEntity } from '$lib/posts/api';
import type { SearchProvider } from '$lib/search/types';
import type { UniversalSearchWiring } from '$lib/search/wiring';

vi.mock('$lib/search/wiring', () => ({ wireUniversalSearch: () => null }));
vi.mock('$lib/components/posts/PostSearchFilters.svelte', async () => ({
  default: (await import('$lib/components/reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/calendar/CalendarEventDetailModal.svelte', async () => ({
  default: (await import('$lib/components/reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('$lib/components/reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/AssociationAvatar.svelte', async () => ({
  default: (await import('$lib/components/reels/AvatarStub.test-helper.svelte')).default,
}));

import UniversalSearch from './UniversalSearch.svelte';

function hits(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix}-${i}`,
    title: `${prefix} ${i}`,
    href: `/x/${prefix}-${i}`,
  }));
}

function fakeProvider(
  section: SearchProvider['section'],
  source: SearchProvider['source'],
  total: number
): SearchProvider {
  return {
    section,
    source,
    search: async ({ limit }) => ({ hits: hits(Math.min(limit, total), section), total }),
  };
}

let mounted: Record<string, unknown> | null = null;
let closed: ReturnType<typeof vi.fn<() => void>>;
let wiringClosed: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  closed = vi.fn<() => void>();
  wiringClosed = vi.fn<() => void>();
});

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function render(providers: SearchProvider[], posts: PostEntity[] = []) {
  const wire = (): UniversalSearchWiring => ({
    providers,
    posts: async () => posts,
    close: wiringClosed,
  });
  const post = createRawSnippet((p: () => PostEntity) => ({
    render: () => `<article data-post-card>${p().id}</article>`,
  }));
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted = mount(UniversalSearch, {
    target,
    props: { open: true, onClose: closed, post: post as never, wire: wire as never },
  });
  flushSync();
  return target;
}

const field = () => document.getElementById('universal-search-input') as HTMLInputElement;

async function type(words: string) {
  field().dispatchEvent(new FocusEvent('focus'));
  field().value = words;
  field().dispatchEvent(new Event('input', { bubbles: true }));
  field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

describe('UniversalSearch', () => {
  it('draws the top 3 of each section that found something, and a chip per section', async () => {
    const root = render([
      fakeProvider('people', 'server', 8),
      fakeProvider('settings', 'device', 1),
      fakeProvider('forms', 'list', 0),
    ]);
    await type('gala');
    const sections = [...root.querySelectorAll('[data-search-section]')].map((s) =>
      s.getAttribute('data-search-section')
    );
    expect(sections).toEqual(['people', 'settings']);
    const people = root.querySelector('[data-search-section="people"]')!;
    expect(people.querySelectorAll('[data-search-hit]')).toHaveLength(3);
    expect(people.querySelector('[data-search-show-all="people"]')?.textContent).toContain(
      m.search_show_all_count({ count: 8 })
    );
    // A short label on one line; the whole sentence for a tooltip and a screen reader.
    const server = root.querySelector('[data-search-source="server"]')!;
    expect(server.textContent).toContain(m.search_source_server_short());
    expect(server.getAttribute('title')).toBe(m.search_source_server());
    expect(server.querySelector('.sr-only')?.textContent).toBe(m.search_source_server());
    expect(root.querySelector('[data-search-source="device"]')?.getAttribute('title')).toBe(
      m.search_source_device()
    );
    expect(root.querySelectorAll('[data-search-chip]')).toHaveLength(8);
  });

  it('opens a whole section from "Tout afficher", its chip pressed', async () => {
    const root = render([fakeProvider('people', 'server', 8)]);
    await type('gala');
    (root.querySelector('[data-search-show-all="people"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(root.querySelector('[data-search-chip="people"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(root.querySelectorAll('[data-search-hit]')).toHaveLength(8);
  });

  it('draws a post as a row in the overview, and as the feed card in its chip', async () => {
    const post = {
      id: 'p-1',
      markdown: 'Le gala',
      authorId: 'u-1',
      authorFirstName: 'Camille',
      authorLastName: 'Galand',
      media: [],
      publishedAt: '2026-11-20T10:00:00.000Z',
      createdAt: '2026-11-20T10:00:00.000Z',
    } as unknown as PostEntity;
    const root = render([], [post]);
    await type('gala');
    const row = root.querySelector('[data-search-section="posts"] [data-search-hit]');
    expect(row?.getAttribute('href')).toBe('/posts/p-1');
    expect(row?.textContent).toContain('Camille Galand');
    expect(root.querySelector('[data-search-section="posts"] [data-post-card]')).toBeNull();
    (root.querySelector('[data-search-chip="posts"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(root.querySelector('[data-search-section="posts"] [data-post-card]')?.textContent).toBe(
      'p-1'
    );
  });

  it('says the device is still reading instead of "nothing found" while the index fills', async () => {
    const root = render([
      {
        section: 'discussions',
        source: 'device',
        search: async () => ({ hits: [], total: 0, partial: true }),
      },
    ]);
    await type('zzz');
    expect(root.querySelector('[data-search-partial]')?.textContent).toContain(
      m.search_discussions_reading()
    );
    expect(root.textContent).not.toContain(m.search_no_results({ query: 'zzz' }));
    expect(root.textContent).not.toContain(m.search_section_empty());
  });

  it('says so when nothing anywhere matched', async () => {
    const root = render([fakeProvider('settings', 'device', 0)]);
    await type('zzz');
    expect(root.textContent).toContain(m.search_no_results({ query: 'zzz' }));
  });

  it('walks the results with the arrow keys and comes back to the field', async () => {
    const root = render([fakeProvider('settings', 'device', 2)]);
    await type('gala');
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const results = root.querySelectorAll<HTMLElement>('[data-search-hit]');
    expect(document.activeElement).toBe(results[0]);
    results[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(results[1]);
    results[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(field());
  });

  it('drops the search and what it read when closed', async () => {
    const root = render([fakeProvider('settings', 'device', 2)]);
    await type('gala');
    (root.querySelector(`[aria-label="${m.search_close_aria()}"]`) as HTMLElement).click();
    flushSync();
    expect(wiringClosed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    expect(root.querySelector('[data-search-section]')).toBeNull();
  });
});
