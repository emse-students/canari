// @vitest-environment happy-dom
/**
 * THE LIVES KILL SWITCH ON THE FEED: closing it takes the card and an open viewer away, and the
 * viewer stays CLOSED when lives reopen in the same session - hiding it used to keep `openLive`
 * set, so the viewer came back on a live nobody had asked to see again.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { clearFeedCache } from '$lib/posts/feedCache';
import { livesModeStub } from '../../test/stubs/livesModeStub.svelte';

vi.mock('$app/state', () => ({
  page: { params: {}, url: new URL('https://canari.test/posts?feed=all'), state: {} },
}));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { userId: null, deviceKeyB64: null, isLoggedIn: false },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
vi.mock('$lib/stores/auth', () => ({ getToken: () => Promise.resolve('token') }));
vi.mock('$lib/features', async (orig) => ({
  ...(await orig<typeof import('$lib/features')>()),
  LIVE_ENABLED: true,
}));
vi.mock('$lib/stores/appVersionCheck.svelte', async (orig) => {
  const { livesModeStub: stub } = await import('../../test/stubs/livesModeStub.svelte');
  return {
    ...(await orig<typeof import('$lib/stores/appVersionCheck.svelte')>()),
    serverLivesMode: () => stub.mode,
  };
});
vi.mock('$lib/posts/api', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/api')>()),
  listPosts: () => Promise.resolve([]),
  getMyScheduledPosts: () => Promise.resolve([]),
  searchPosts: () => Promise.resolve([]),
}));
vi.mock(
  '$lib/components/live/LiveFeedCard.svelte',
  async () => import('../../test/stubs/LiveCardStub.svelte')
);
vi.mock(
  '$lib/components/live/LiveViewer.svelte',
  async () => import('../../test/stubs/LiveViewerStub.svelte')
);
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
  livesModeStub.mode = 'on';
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

const card = () => document.querySelector<HTMLButtonElement>('[data-stub="live-card"]');
const viewer = () => document.querySelector('[data-stub="live-viewer"]');

describe('the feed and the lives kill switch', () => {
  it('closing lives takes the card and the open viewer away, and reopening brings back the card only', async () => {
    const data = { posts: Promise.resolve([]), feedParams: { feed: 'all' as const } };
    const app = mount(Page, { target: document.body, props: { data } });
    mounted.push(() => unmount(app));
    await settle();

    card()!.click();
    await settle();
    expect(viewer()).not.toBeNull();

    livesModeStub.mode = 'off';
    await settle();
    expect(card()).toBeNull();
    expect(viewer()).toBeNull();

    livesModeStub.mode = 'on';
    await settle();
    expect(card()).not.toBeNull();
    expect(viewer()).toBeNull();
  });
});
