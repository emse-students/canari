// @vitest-environment happy-dom
/**
 * A BARE `/posts` NAMES THE TAB IT DREW (Mi 9T, `1.7.0-alpha.4`, 3 of 3: Organisations scrolled, a
 * profile, an association, Back twice - the feed came back on "Pour toi" at the top).
 *
 * `load` resolves a bare address from the remembered preference, which a later tap overwrites, so a
 * history entry addressed bare reopens on the tab chosen last and its remembered anchor points into
 * another list. The page writes the drawn tab into the address with a shallow `replaceState`, once the
 * router exists. This pins that write; the real router and the WebView's history are the phone's.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { clearFeedCache } from '$lib/posts/feedCache';
import { markRouterReady } from '$lib/navigation/routerReady';
import { adoptTransitionAnimations } from '../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const page = vi.hoisted(() => ({
  params: {},
  url: new URL('https://canari.test/posts'),
  state: {},
}));
vi.mock('$lib/follows/suggestions.svelte', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureFeedSuggestions: () => {},
}));
vi.mock('$app/state', () => ({ page }));

const replaceState = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', async (orig) => ({
  ...(await orig<typeof import('$app/navigation')>()),
  goto: vi.fn(),
  replaceState,
}));

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { userId: null, deviceKeyB64: null, isLoggedIn: false },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1' }));
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
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  replaceState.mockReset();
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

function open(path: string, feed: 'associations' | 'foryou' | 'all') {
  page.url = new URL(`https://canari.test${path}`);
  const data = { posts: Promise.resolve([]), feedParams: { feed } };
  const app = mount(Page, { target: document.body, props: { data } });
  mounted.push(() => unmount(app));
}

describe('the feed address names its tab', () => {
  it('writes the drawn tab into a bare address once the router is ready', async () => {
    open('/posts', 'associations');
    await settle();
    markRouterReady();
    await settle();

    expect(replaceState).toHaveBeenCalledOnce();
    expect(String(replaceState.mock.calls[0][0])).toContain('/posts?feed=associations');
  });

  it('writes nothing when the address already names a tab', async () => {
    open('/posts?feed=foryou', 'foryou');
    await settle();
    markRouterReady();
    await settle();

    expect(replaceState).not.toHaveBeenCalled();
  });
});
