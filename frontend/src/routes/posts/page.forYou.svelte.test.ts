// @vitest-environment happy-dom
/**
 * POUR TOI ON THE FEED PAGE (owner, 2026-11-10): a suggested post is one of its own rows, merged by
 * the server (`feedSuggested`) and drawn in place with the "Suggestion" badge; the follow-suggestion
 * carousel is read for Pour toi alone - Campus and Associations are pure lists; the next page is
 * asked of the same ranking after the last place served; a next page refused 503 offers a retry
 * rather than ending the list, and a ranking gone (410) is ranked anew without drawing a post twice.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { PostEntity } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';
import { clearFeedCache } from '$lib/posts/feedCache';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

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
/** A FULL first page of Pour toi (`FEED_FIRST_PAGE_SIZE`), place 3 withdrawn: it ends at 20. */
const forYouFull = () =>
  Array.from({ length: 20 }, (_, i) => post(`f${i}`, { position: i < 3 ? i : i + 1 }));
const feed = () => Array.from({ length: 10 }, (_, i) => post(`f${i}`));
const mounted: (() => void)[] = [];
/** The sentinel's observers: firing one is the reader reaching the bottom of the list. */
const observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
const reachBottom = async () => {
  observers.at(-1)!([{ isIntersecting: true }]);
  await settle();
};
const drawnIds = () =>
  [...document.querySelectorAll('[data-stub="mount-counter"]')].map((el) => el.textContent);

beforeEach(() => {
  (globalThis as Record<string, unknown>).__mounts = [];
  clearFeedCache();
  ensureFeedSuggestions.mockReset();
  listPosts.mockReset().mockResolvedValue([]);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  observers.length = 0;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        observers.push(cb);
      }
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

  it('asks the next page of the same ranking after the last place served', async () => {
    await draw('foryou', forYouFull());
    await reachBottom();
    expect(listPosts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        feed: 'foryou',
        offset: 21,
        asOf: '2026-11-10T12:00:00.000000Z',
        rankedFeeds: true,
      })
    );
  });

  it('a next page refused 503 offers a retry, and the retry appends the page', async () => {
    listPosts.mockRejectedValueOnce(new ApiRefusalError(503, 'RANKING_UNAVAILABLE', 'x'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await draw('foryou', forYouFull());
    await reachBottom();
    const failed = document.querySelector('[data-load-more-failed]');
    expect(failed).not.toBeNull();
    expect(failed!.textContent).toContain(m.posts_load_more_error());
    expect(document.body.textContent).not.toContain(m.posts_all_loaded());
    listPosts.mockResolvedValueOnce([post('n1', { position: 21 })]);
    (failed!.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector('[data-load-more-failed]')).toBeNull();
    expect(drawnIds()).toContain('n1');
  });

  it('a ranking gone (410) is ranked anew and only the posts not drawn yet are appended', async () => {
    listPosts.mockRejectedValueOnce(new ApiRefusalError(410, 'RANKING_GONE', 'gone'));
    listPosts.mockResolvedValueOnce([
      { ...post('f0'), feedAsOf: '2026-11-10T14:00:00.000000Z', feedPosition: 0 },
      { ...post('n1'), feedAsOf: '2026-11-10T14:00:00.000000Z', feedPosition: 1 },
    ] as PostEntity[]);
    await draw('foryou', forYouFull());
    await reachBottom();
    expect(listPosts).toHaveBeenCalledWith(
      expect.objectContaining({ feed: 'foryou', offset: 0, rankedFeeds: true })
    );
    const ids = drawnIds();
    expect(ids.filter((id) => id === 'f0')).toHaveLength(1);
    expect(ids.at(-1)).toBe('n1');
  });

  it('Campus carries no suggestion', async () => {
    await draw('all', feed());
    expect(document.querySelector('[data-suggested-post]')).toBeNull();
  });
});
