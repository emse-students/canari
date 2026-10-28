// @vitest-environment happy-dom
/**
 * `?compose=1` AND `?search=1` SURVIVE THEIR OWN STRIP.
 *
 * The feed performs each command and strips it with a `goto`. That `goto` is a navigation, and the
 * root layout's `beforeNavigate` closes every open overlay (`drainHistoryOverlayStack`). SvelteKit
 * 2 skipped that hook for a `goto` fired while the arrival was still open; SvelteKit 3 runs it, so a
 * composer opened in the same tick was closed the instant it opened (Mi 9T, 2026-10-28). The `goto`
 * double below is kit 3's order: a microtask, the layout's drain, then the new URL.
 *
 * What this cannot see: the real router, the real root layout and the WebView's history. It pins
 * the order the route relies on, and the phone reading is what proves the router still has it.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { clearFeedCache } from '$lib/posts/feedCache';
import { drainHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import { adoptTransitionAnimations } from '../../test/adoptTransitionAnimations';

// The composer is a Modal unmounted while its transition runs.
afterAll(adoptTransitionAnimations());

const page = vi.hoisted(() => ({
  params: {},
  url: new URL('https://canari.test/posts'),
  state: {},
}));
vi.mock('$app/state', () => ({ page }));

const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', async (orig) => ({
  ...(await orig<typeof import('$app/navigation')>()),
  goto,
}));

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { userId: null, deviceKeyB64: null, isLoggedIn: false },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: () => Promise.resolve([]),
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

const mounted: (() => void)[] = [];

beforeEach(() => {
  clearFeedCache();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  // Kit 3's order: the intent is awaited, then the layout's `beforeNavigate` drains the overlays,
  // then the page carries the new URL.
  goto.mockImplementation(async (href: string) => {
    await Promise.resolve();
    drainHistoryOverlayStack();
    page.url = new URL(href, page.url);
  });
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  goto.mockReset();
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

function open(query: string) {
  page.url = new URL(`https://canari.test/posts?${query}`);
  const data = { posts: Promise.resolve([]), feedParams: { feed: 'all' as const } };
  const app = mount(Page, { target: document.body, props: { data } });
  mounted.push(() => unmount(app));
}

const composer = () => document.querySelector('[role="dialog"][aria-modal="true"]');

describe('the feed commands of the app header', () => {
  it('?compose=1 opens the composer, and it stays open once the command is stripped', async () => {
    open('compose=1');
    await settle();

    expect(goto).toHaveBeenCalledOnce();
    expect(goto.mock.calls[0][0]).not.toContain('compose');
    expect(page.url.search).toBe('');
    expect(composer()).not.toBeNull();
  });

  it('?search=1 opens the search field, and it stays open once the command is stripped', async () => {
    open('search=1');
    await settle();

    expect(goto.mock.calls[0][0]).not.toContain('search');
    expect(document.getElementById('posts-search')!.classList.contains('hidden')).toBe(false);
  });

  it('drops the command, without accusing, when another navigation overtakes the strip', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    goto.mockImplementation(async () => {
      await Promise.resolve();
      drainHistoryOverlayStack();
      page.url = new URL('https://canari.test/chat');
      throw new Error('navigation aborted');
    });
    open('compose=1');
    await settle();

    expect(composer()).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps the other parameters of the address it strips', async () => {
    open('feed=followed&compose=1');
    await settle();

    expect(page.url.searchParams.get('feed')).toBe('followed');
    expect(page.url.searchParams.has('compose')).toBe(false);
    expect(composer()).not.toBeNull();
  });
});
