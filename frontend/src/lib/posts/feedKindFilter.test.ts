/**
 * The CanaReels filter: its vocabulary, the order `load` resolves it in, a storage that refuses, the
 * slot a filtered first page is stored under, and the `kind` the server is asked for - the SERVER
 * narrows, so a filtered page is never a client-side cut of the whole feed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEED_KIND_FILTERS,
  advanceLastSeen,
  feedKindFilterOf,
  feedKindParam,
  feedPageOptions,
  kindForTabSwitch,
  landingAfterPublish,
  parseFeedKindFilter,
  readPreferredFeedKind,
  rememberFeedKind,
  resetFeedKindSession,
  resolveFeedKind,
} from './feedKindFilter';
import { storedFeedKey } from './feedStore';
import { feedCacheKey } from './feedCache';
import { listPosts } from './api';

const fetched: string[] = [];
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: (url: string) => {
    fetched.push(url);
    return Promise.resolve(new Response('[]', { status: 200 }));
  },
}));
vi.mock('$lib/utils/apiUrl', () => ({ socialUrl: () => '' }));
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'alice' }));

beforeEach(() => {
  localStorage.clear();
  resetFeedKindSession();
  fetched.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the filter vocabulary', () => {
  it('accepts every name it publishes and says NOTHING (not the default) otherwise', () => {
    for (const filter of FEED_KIND_FILTERS) expect(parseFeedKindFilter(filter)).toBe(filter);
    for (const value of [null, undefined, '', 'Reel', 'post', 'toString']) {
      expect(parseFeedKindFilter(value)).toBeNull();
    }
  });

  it('maps to the server kind and back: only `reel` narrows', () => {
    expect(feedKindParam('reel')).toBe('reel');
    expect(feedKindParam('all')).toBeUndefined();
    expect(feedKindFilterOf('reel')).toBe('reel');
    expect(feedKindFilterOf(undefined)).toBe('all');
    expect(feedKindFilterOf('post')).toBe('all');
  });
});

describe('the order load resolves it in', () => {
  it('the URL wins over the remembered choice, which wins over the whole feed', () => {
    expect(resolveFeedKind(null)).toBe('all');
    rememberFeedKind('reel');
    expect(resolveFeedKind(null)).toBe('reel');
    expect(resolveFeedKind('all')).toBe('all');
    expect(resolveFeedKind('nonsense')).toBe('reel');
  });

  it('a storage that throws opens the whole feed and remembers nothing, without throwing', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    expect(readPreferredFeedKind()).toBeNull();
    expect(resolveFeedKind(null)).toBe('all');
    expect(resolveFeedKind('reel')).toBe('reel');
    // The choice still holds for the session, though nothing could be stored.
    expect(() => rememberFeedKind('reel')).not.toThrow();
    expect(resolveFeedKind(null)).toBe('reel');
  });

  it('a storage that reads a stale "reel" but refuses the write cannot undo a choice of "all"', () => {
    localStorage.setItem('canari_post_feed_kind', 'reel');
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    rememberFeedKind('all');
    expect(localStorage.getItem('canari_post_feed_kind')).toBe('reel');
    expect(resolveFeedKind(null)).toBe('all');
    expect(kindForTabSwitch()).toBe('all');
  });
});

describe('the filtered first page has a slot of its own', () => {
  it('stored under feed:<tab>:reel, never the tab slot', () => {
    expect(storedFeedKey({ feed: 'all' })).toBe('feed:all');
    expect(storedFeedKey({ feed: 'all', kind: 'reel' })).toBe('feed:all:reel');
    expect(storedFeedKey({ feed: 'associations', kind: 'reel' })).toBe('feed:associations:reel');
    // A link's promo filter stays unstored, filtered or not.
    expect(storedFeedKey({ feed: 'all', promo: 2024, kind: 'reel' })).toBeNull();
  });

  it('held in memory under its own key', () => {
    expect(feedCacheKey({ feed: 'all', kind: 'reel' })).not.toBe(feedCacheKey({ feed: 'all' }));
  });
});

describe('the server narrows', () => {
  it('asks kind=reel on the tab, with the paging, so no page is cut on the device', async () => {
    await listPosts({ feed: 'associations', kind: 'reel', limit: 10, offset: 20 });
    const query = new URLSearchParams(fetched[0].split('?')[1]);
    expect(query.get('kind')).toBe('reel');
    expect(query.get('feed')).toBe('associations');
    expect(query.get('offset')).toBe('20');
  });

  it('the whole feed carries no kind', async () => {
    await listPosts({ feed: 'followed', limit: 20, kind: feedKindParam('all') });
    expect(fetched[0]).not.toContain('kind=');
  });
});

describe('every page of a filtered feed keeps the filter', () => {
  it('the infinite scroll and the refresh ask the same kind as the first page', () => {
    const params = { feed: 'associations' as const, kind: 'reel' as const };
    expect(feedPageOptions(params, 30, 10)).toEqual({
      feed: 'associations',
      kind: 'reel',
      offset: 30,
      limit: 10,
    });
    expect(feedPageOptions({ feed: 'all' }, 0, 10)).not.toHaveProperty('kind');
  });
});

describe('the "new" mark', () => {
  it('advances on the whole feed, and the CanaReels view leaves it where it is', () => {
    expect(advanceLastSeen(100, [90, 140, 120], 'all')).toBe(140);
    expect(advanceLastSeen(100, [90], 'all')).toBe(100);
    expect(advanceLastSeen(100, [140, 120], 'reel')).toBe(100);
  });
});

describe('after a publish', () => {
  it('while filtered, the whole feed is shown, for this visit only', () => {
    expect(landingAfterPublish('associations', 'reel', null)).toEqual({
      feed: 'associations',
      kind: 'all',
    });
    expect(landingAfterPublish('followed', 'reel', 'associations')).toEqual({
      feed: 'associations',
      kind: 'all',
    });
  });

  it('unfiltered, the tab rule is unchanged and no kind is written', () => {
    expect(landingAfterPublish('all', 'all', 'associations')).toBeNull();
    expect(landingAfterPublish('followed', 'all', 'associations')).toEqual({
      feed: 'associations',
    });
  });

  it('the next tab switch writes the CHOICE back, so the publish kind does not stick', () => {
    expect(kindForTabSwitch()).toBeNull();
    rememberFeedKind('reel');
    expect(kindForTabSwitch()).toBe('reel');
  });
});
