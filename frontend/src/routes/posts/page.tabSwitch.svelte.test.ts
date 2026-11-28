// @vitest-environment happy-dom
/**
 * A TAB NEVER SEEN IN THIS PROCESS REPLACES THE LIST WITHOUT PASSING THROUGH NULL.
 *
 * iPhone 12, 1.8.0-alpha.7 to alpha.9: the first post published after each app start drew the "500"
 * page (`null is not an object (evaluating 't().slice')`, the feed's keyed `{#each}`). The publish
 * switched the reader from "Pour toi" to Campus (`feedToShowAfterPublish`), a tab with no in-memory
 * entry yet in that process, so the tab load emptied the list (`shownPosts` null: the skeleton is the
 * new tab's loading state). In the same flush `progressiveCount` WROTE its reset count from its
 * `$effect`; that write re-ran the `{#each}` eagerly, and the commit that run registered re-read the
 * each's collection - null by then - before the `{#if}` around it was torn down. A feed still
 * mounting (count already at its first screen) wrote nothing, so only a fully mounted feed crashed,
 * and every later publish found the tab cached and never emptied the list.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { PostEntity, PostFeed } from '$lib/posts/api';
import { clearFeedCache } from '$lib/posts/feedCache';

// The follow suggestions (engagement WP-6) are a read of their own: none in these feeds.
vi.mock('$lib/follows/suggestions.svelte', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureFeedSuggestions: () => {},
}));
vi.mock('$app/state', () => ({
  page: { params: {}, url: new URL('https://canari.test/posts?feed=foryou'), state: {} },
}));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { userId: null, deviceKeyB64: null, isLoggedIn: false },
}));
// The Alumni link card at the top of the feed reads the own profile: none is due here.
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'u1',
  fetchMyProfile: () => Promise.resolve({}),
}));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: () => Promise.resolve([]),
  getScheduledPostsToEdit: () => Promise.resolve([]),
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

const post = (id: string, position?: number) =>
  ({
    id,
    ...(position === undefined
      ? {}
      : { feedAsOf: '2026-11-10T12:00:00.000000Z', feedPosition: position }),
    publishedAt: '2026-10-16T00:00:00Z',
    createdAt: '2026-10-16T00:00:00Z',
  }) as unknown as PostEntity;
const cards = () =>
  [...document.querySelectorAll('[data-scroll-anchor]')].map((el) =>
    el.getAttribute('data-scroll-anchor')
  );
const mounted: (() => void)[] = [];
/** Animation frames, run by the test: the progressive mount advances when it says so, never a clock. */
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

/** Runs every frame requested so far, and the ones they request, until none is left. */
async function runFrames() {
  for (let guard = 0; frames.size > 0 && guard < 100; guard++) {
    const due = [...frames.values()];
    frames.clear();
    due.forEach((cb) => cb(0));
    await settle();
  }
}

beforeEach(() => {
  clearFeedCache();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  frames.clear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
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

describe('switching to a tab this process has never loaded', () => {
  it('draws the skeleton of the new tab, then its answer, from a fully mounted feed', async () => {
    const props = $state({
      data: {
        posts: Promise.resolve(Array.from({ length: 12 }, (_, i) => post(`p${i}`, i))),
        feedParams: { feed: 'foryou' as PostFeed },
      },
    });
    const app = mount(Page, { target: document.body, props });
    mounted.push(() => unmount(app));
    await settle();
    // Every card mounted: the switch must take the count back to the first screen.
    await runFrames();
    expect(cards().length).toBe(12);

    // What `showFeed('all')` hands the page: the load's new params and its still-pending answer.
    let answer!: (posts: PostEntity[]) => void;
    const pending = new Promise<PostEntity[]>((resolve) => (answer = resolve));
    props.data = { posts: pending, feedParams: { feed: 'all' as PostFeed } };
    await settle();
    await runFrames();

    // The answer has not come: the new tab's loading state, and no crash.
    expect(cards()).toEqual([]);
    expect(document.querySelector('.animate-pulse')).not.toBeNull();

    answer([post('n'), post('a')]);
    await settle();
    expect(cards()).toEqual(['n', 'a']);
  });
});
