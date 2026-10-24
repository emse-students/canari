// @vitest-environment happy-dom
/**
 * THE FEED'S FIRST ANSWER MOUNTS EACH CARD ONCE (Mi 9T, v1.2.9-alpha.3). The `{#await}` drew the
 * answer, then its handler moved it into `postsOverride`, drawn by another block: every card mounted
 * twice, and the reel on screen opened its stream twice. The list is now drawn from one block
 * (`shownPosts`). The refresh asks the same first page as the cold start (`FEED_FIRST_PAGE_SIZE`).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { FEED_FIRST_PAGE_SIZE } from '$lib/posts/feedPageSize';
import type { PostEntity } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';
import { clearFeedCache } from '$lib/posts/feedCache';

const listPosts = vi.hoisted(() => vi.fn());

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
const mounts = () => ((globalThis as Record<string, unknown>).__mounts ?? []) as string[];
const mounted: (() => void)[] = [];

beforeEach(() => {
  (globalThis as Record<string, unknown>).__mounts = [];
  clearFeedCache();
  listPosts.mockReset().mockResolvedValue([post('a'), post('b')]);
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
  for (let i = 0; i < 10; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

describe('the feed first draw', () => {
  it('mounts each card of the first answer once', async () => {
    const data = {
      posts: Promise.resolve([post('a'), post('b')]),
      feedParams: { feed: 'all' as const },
    };
    const app = mount(Page, { target: document.body, props: { data } });
    mounted.push(() => unmount(app));
    await settle();

    const cards = mounts().filter((id) => id === 'a' || id === 'b');
    expect(cards.sort()).toEqual(['a', 'b']);
  });

  it('a refresh asks the first page the cold start asked, not a scroll page', async () => {
    // The cold start got no answer; "Reessayer" is the refresh the reconnect also takes.
    const failed = Promise.reject(new TypeError('Failed to fetch'));
    failed.catch(() => {});
    const data = { posts: failed, feedParams: { feed: 'all' as const } };
    const app = mount(Page, { target: document.body, props: { data } });
    mounted.push(() => unmount(app));
    await settle();

    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === m.common_retry_button()
    );
    expect(retry).toBeDefined();
    retry!.click();
    await settle();

    expect(listPosts).toHaveBeenCalledTimes(1);
    expect(listPosts.mock.calls[0][0]).toMatchObject({
      feed: 'all',
      offset: 0,
      limit: FEED_FIRST_PAGE_SIZE,
    });
    expect(
      mounts()
        .filter((id) => id === 'a' || id === 'b')
        .sort()
    ).toEqual(['a', 'b']);
  });
});
