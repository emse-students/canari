// @vitest-environment happy-dom
/**
 * THE LIVE REPLACES THE COMPOSER (owner, 2026-10-31): choosing "En direct" in "Nouvelle publication"
 * closes the composer and opens the broadcaster's screen on the feed; ending the live leaves the
 * feed with no composer behind it. Closed by state, never by a clock.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { tick } from 'svelte';
import { clearFeedCache } from '$lib/posts/feedCache';
import { livesModeStub } from '../../test/stubs/livesModeStub.svelte';
import { m } from '$lib/paraglide/messages';

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
  '$lib/components/live/LiveOverlay.svelte',
  async () => import('../../test/stubs/LiveOverlayStub.svelte')
);
vi.mock(
  '$lib/components/shared/Modal.svelte',
  async () => import('../../test/stubs/ModalStub.svelte')
);
vi.mock(
  '$lib/components/posts/CreatePostForm.svelte',
  async () => import('../../test/stubs/ComposerGoLiveStub.svelte')
);
vi.mock(
  '$lib/components/posts/PostCard.svelte',
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

const q = (sel: string) => document.querySelector<HTMLElement>(sel);

describe('going live from the composer', () => {
  it('closes the composer, shows the live, and ending it leaves the feed with no composer', async () => {
    const data = { posts: Promise.resolve([]), feedParams: { feed: 'all' as const } };
    const app = mount(Page, { target: document.body, props: { data } });
    mounted.push(() => unmount(app));
    await settle();

    const open = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(m.posts_publish_button())
    )!;
    open.click();
    await settle();
    expect(q('[data-stub="modal"]')).not.toBeNull();
    expect(q('[data-stub="live-overlay"]')).toBeNull();

    q('[data-stub="composer-go-live"]')!.click();
    await settle();
    expect(q('[data-stub="modal"]')).toBeNull();
    expect(q('[data-stub="live-overlay"]')).not.toBeNull();

    q('[data-stub="live-overlay-end"]')!.click();
    await settle();
    expect(q('[data-stub="live-overlay"]')).toBeNull();
    expect(q('[data-stub="modal"]')).toBeNull();
  });
});
