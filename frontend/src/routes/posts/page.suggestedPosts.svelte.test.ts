// @vitest-environment happy-dom
/**
 * A SUGGESTED POST IN MON ESPACE (engagement WP-7, L13): drawn after the 7th feed post with its
 * "Suggestion" badge, and only in Mon espace - Suivis never carries one.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { PostEntity } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';
import { clearFeedCache } from '$lib/posts/feedCache';

const listPosts = vi.hoisted(() => vi.fn());

// The follow suggestions (engagement WP-6) are a read of their own: none in these feeds.
vi.mock('$lib/follows/suggestions.svelte', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureFeedSuggestions: () => {},
}));
vi.mock('$lib/posts/suggestedPosts.svelte', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureSuggestedPosts: () => {},
  suggestedPosts: () => [
    { id: 's1', publishedAt: '2026-10-16T00:00:00Z', createdAt: '2026-10-16T00:00:00Z' },
  ],
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

const post = (id: string) =>
  ({
    id,
    publishedAt: '2026-10-16T00:00:00Z',
    createdAt: '2026-10-16T00:00:00Z',
  }) as unknown as PostEntity;
const feed = () => Array.from({ length: 10 }, (_, i) => post(`f${i}`));
const mounted: (() => void)[] = [];

beforeEach(() => {
  (globalThis as Record<string, unknown>).__mounts = [];
  clearFeedCache();
  listPosts.mockReset().mockResolvedValue(feed());
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

async function draw(feedName: 'all' | 'followed') {
  const data = { posts: Promise.resolve(feed()), feedParams: { feed: feedName } };
  const app = mount(Page, { target: document.body, props: { data } });
  mounted.push(() => unmount(app));
  await settle();
}

describe('a suggested post in the feed', () => {
  it('Mon espace draws it after the 7th post, marked Suggestion', async () => {
    await draw('all');
    const slot = document.querySelector('[data-suggested-post="s1"]');
    expect(slot).not.toBeNull();
    expect(slot!.textContent).toContain(m.suggestion_post_badge());
    // The stub card prints its post id: the slot sits right under f6, the 7th post.
    const cards = [...document.querySelectorAll('[data-stub="mount-counter"]')].map(
      (el) => el.textContent
    );
    expect(cards.indexOf('s1')).toBe(cards.indexOf('f6') + 1);
  });

  it('Suivis never carries one', async () => {
    await draw('followed');
    expect(document.querySelector('[data-suggested-post]')).toBeNull();
  });
});
