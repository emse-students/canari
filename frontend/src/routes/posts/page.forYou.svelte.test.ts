// @vitest-environment happy-dom
/**
 * POUR TOI ON THE FEED PAGE (owner, 2026-11-10): a suggested post is one of its own rows, merged by
 * the server (`feedSuggested`) and drawn in place with the "Suggestion" badge; the follow-suggestion
 * carousel is read for Pour toi alone - Campus and Associations are pure lists; the next page is
 * asked of the same ranking after the last place served.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { PostEntity } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';
import { clearFeedCache } from '$lib/posts/feedCache';

const listPosts = vi.hoisted(() => vi.fn());
const ensureFeedSuggestions = vi.hoisted(() => vi.fn());

// The follow suggestions (engagement WP-6) are a read of their own: counted, never answered.
vi.mock('$lib/follows/suggestions.svelte', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureFeedSuggestions,
}));
vi.mock('$app/state', () => ({
  page: { params: {}, url: new URL('https://canari.test/posts?feed=all'), state: {} },
}));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { userId: null, deviceKeyB64: null, isLoggedIn: false },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts,
  getMyScheduledPosts: () => Promise.resolve([]),
  searchPosts: () => Promise.resolve([]),
}));
vi.mock(
  '$lib/components/posts/PostCard.svelte',
  async () => import('../../test/stubs/MountCounter.svelte')
);
vi.mock(
  '$lib/components/posts/CreatePostForm.svelte',
  async () => import('../../test/stubs/MountCounter.svelte')
);
vi.mock(
  '$lib/components/posts/ScheduledPostsPanel.svelte',
  async () => import('../../test/stubs/MountCounter.svelte')
);
vi.mock(
  '$lib/components/posts/ConversationsMiniPanel.svelte',
  async () => import('../../test/stubs/MountCounter.svelte')
);

import Page from './+page.svelte';

const post = (id: string, ranked?: { position: number; suggested?: boolean }) =>
  ({
    id,
    publishedAt: '2026-10-16T00:00:00Z',
    createdAt: '2026-10-16T00:00:00Z',
    ...(ranked
      ? {
          feedAsOf: '2026-11-10T12:00:00.000000Z',
          feedPosition: ranked.position,
          ...(ranked.suggested ? { feedSuggested: true } : {}),
        }
      : {}),
  }) as unknown as PostEntity;
/** A full first page of Pour toi; position 3 was withdrawn on the server, s1 is a suggestion. */
const forYou = () =>
  Array.from({ length: 10 }, (_, i) => {
    const position = i < 3 ? i : i + 1;
    return i === 4 ? post('s1', { position, suggested: true }) : post(`f${i}`, { position });
  });
const feed = () => Array.from({ length: 10 }, (_, i) => post(`f${i}`));
const mounted: (() => void)[] = [];

beforeEach(() => {
  (globalThis as Record<string, unknown>).__mounts = [];
  clearFeedCache();
  ensureFeedSuggestions.mockReset();
  listPosts.mockReset().mockResolvedValue([]);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 20; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function draw(feedName: 'all' | 'foryou' | 'associations', rows: PostEntity[]) {
  const data = { posts: Promise.resolve(rows), feedParams: { feed: feedName } };
  const app = mount(Page, { target: document.body, props: { data } });
  mounted.push(() => unmount(app));
  await settle();
}

describe('Pour toi on the feed page', () => {
  it('draws a suggested post in its own place, marked Suggestion', async () => {
    await draw('foryou', forYou());
    const slot = document.querySelector('[data-suggested-post="s1"]');
    expect(slot).not.toBeNull();
    expect(slot!.textContent).toContain(m.suggestion_post_badge());
    const cards = [...document.querySelectorAll('[data-stub="mount-counter"]')].map(
      (el) => el.textContent
    );
    expect(cards.indexOf('s1')).toBe(cards.indexOf('f3') + 1);
    expect(document.querySelectorAll('[data-suggested-post]')).toHaveLength(1);
  });

  it('reads the follow suggestions in Pour toi only', async () => {
    await draw('all', feed());
    await draw('associations', feed());
    expect(ensureFeedSuggestions).not.toHaveBeenCalled();
    await draw('foryou', forYou());
    expect(ensureFeedSuggestions).toHaveBeenCalled();
  });

  it('Campus carries no suggestion', async () => {
    await draw('all', feed());
    expect(document.querySelector('[data-suggested-post]')).toBeNull();
  });
});
