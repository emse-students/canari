// @vitest-environment happy-dom
/**
 * SLOW-LINK CHANTIER, GAP 1 (2026-11-11): THE FEED DRAWS WHILE THE NETWORK ANSWERS NOTHING.
 *
 * At a cold start every authenticated read waits for the session refresh (4 s on the owner's link,
 * server 17 ms) - the feed's first page included, and it must: no read leaves without its token. The
 * feed does not wait for it: on an unlock that prompts nobody (the vault, or the keystore with no
 * prompt due - `unlockUnattendedFor`) the device key is in hand before the token, and the tab's stored
 * first page is drawn from it. This pins the number that closes the screen: the first paint with the
 * first page never answering and no session up.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { PostEntity } from '$lib/posts/api';
import { clearFeedCache } from '$lib/posts/feedCache';

const loadStoredFeed = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ userId: 'u1', deviceKeyB64: 'k', isLoggedIn: false }));
const unattended = vi.hoisted(() => ({ for: 'u1' as string | null }));

vi.mock('$lib/follows/suggestions.svelte', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureFeedSuggestions: () => {},
}));
vi.mock('$app/state', () => ({
  page: { params: {}, url: new URL('https://canari.test/posts?feed=all'), state: {} },
}));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ globalSession: session }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/unlockPath.svelte', () => ({ unlockUnattendedFor: () => unattended.for }));
// The token never comes: the session refresh is still on the wire.
vi.mock('$lib/stores/auth', () => ({ getToken: () => new Promise(() => {}) }));
vi.mock('$lib/posts/feedStore', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/feedStore')>()),
  loadStoredFeed,
}));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: () => new Promise(() => {}),
  getMyScheduledPosts: () => new Promise(() => {}),
  searchPosts: () => new Promise(() => {}),
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
  unattended.for = 'u1';
  loadStoredFeed.mockReset().mockResolvedValue([post('a'), post('b')]);
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

/** The first page as `load` hands it over, never answering: the refresh it waits on is stuck. */
const silentData = () => ({
  posts: new Promise<PostEntity[]>(() => {}),
  feedParams: { feed: 'all' as const },
});

describe('the feed on a link that answers nothing', () => {
  it('draws the stored first page with no token and no session up', async () => {
    const app = mount(Page, { target: document.body, props: { data: silentData() } });
    mounted.push(() => unmount(app));
    await settle();

    expect(loadStoredFeed).toHaveBeenCalledWith(
      { userId: 'u1', deviceKeyB64: 'k' },
      {
        feed: 'all',
      }
    );
    expect(
      mounts()
        .filter((id) => id === 'a' || id === 'b')
        .sort()
    ).toEqual(['a', 'b']);
  });

  it('draws nothing stored while an unlock prompt is owed (a locked device shows nothing)', async () => {
    unattended.for = null;
    const app = mount(Page, { target: document.body, props: { data: silentData() } });
    mounted.push(() => unmount(app));
    await settle();

    expect(loadStoredFeed).not.toHaveBeenCalled();
    expect(mounts().filter((id) => id === 'a' || id === 'b')).toEqual([]);
  });
});
