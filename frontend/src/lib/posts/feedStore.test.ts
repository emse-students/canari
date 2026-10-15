/**
 * The feed's stored first page (local-first feed, 2026-10-15): drawn only for its own account while
 * no unlock is pending, never carrying the reader's rights, ended by a sign-out, a change of account
 * or a refusal, and replaced whole by the server's first page.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import type { PostEntity } from '$lib/posts/api';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { clearUserLocally, saveUserLocally } from '$lib/stores/user';
import { isOutsideFeedAudience } from '$lib/posts/feedAudience';
import {
  feedRefusalEndsCopy,
  feedStoreAccess,
  listAfterFirstPage,
  readStoredFeedPage,
  storableFeedRow,
  storedFeedKey,
  writeStoredFeedPage,
  type FeedStoreAccess,
} from './feedStore';
import { currentFeedEpoch, forgetStoredFeeds } from './feedStoreEpoch';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ALICE: FeedStoreAccess = { userId: 'alice', deviceKeyB64: KEY };
const ALL = { feed: 'all' as const };
let n = 0;

function post(id: string, extra: Partial<PostEntity> = {}): PostEntity {
  return {
    id,
    markdown: `post ${id}`,
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [],
    createdAt: '2026-10-15T08:00:00.000Z',
    publishedAt: '2026-10-15T08:00:00.000Z',
    updatedAt: '2026-10-15T08:00:00.000Z',
    ...extra,
  };
}

async function openStore(): Promise<IndexedDbStorage> {
  const storage = new IndexedDbStorage(`feed-store-${Date.now()}-${n++}`);
  await storage.init();
  return storage;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('canari_saved_user', 'alice');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('feedStoreAccess - nothing is drawn while an unlock is pending', () => {
  const base = {
    currentUserId: 'alice',
    sessionUserId: 'alice',
    deviceKeyB64: KEY,
    isLoggedIn: false,
    unattendedFor: null as string | null,
  };

  it('refuses a device whose unlock prompts the member (a PIN or a fingerprint is owed)', () => {
    expect(feedStoreAccess(base)).toBeNull();
  });

  it('opens for an unlock that prompts nobody, and for a session that is up', () => {
    expect(feedStoreAccess({ ...base, unattendedFor: 'alice' })).toEqual(ALICE);
    expect(feedStoreAccess({ ...base, isLoggedIn: true })).toEqual(ALICE);
  });

  it('refuses another account: an unattended unlock for someone else, or a key that is not ours', () => {
    expect(feedStoreAccess({ ...base, unattendedFor: 'bob' })).toBeNull();
    expect(feedStoreAccess({ ...base, isLoggedIn: true, sessionUserId: 'bob' })).toBeNull();
    expect(feedStoreAccess({ ...base, isLoggedIn: true, deviceKeyB64: '' })).toBeNull();
    expect(feedStoreAccess({ ...base, isLoggedIn: true, currentUserId: null })).toBeNull();
  });
});

describe('what a stored row may carry', () => {
  it('drops every served right and offers no vote, so a read grant can never vote from the copy', () => {
    const served = post('p1', {
      canManage: true,
      canPin: true,
      canReport: true,
      canUnmaskAnonymous: true,
      canRepublish: true,
      canProposeRepublication: true,
      canUnrepublishAs: ['a1'],
      canVote: true,
      reactions: { bob: 'like' },
    });
    const stored = storableFeedRow(served);
    expect(Object.keys(stored).filter((k) => /^can[A-Z]/.test(k))).toEqual(['canVote']);
    expect(stored.canVote).toBe(false);
    expect(stored.reactions).toEqual({ bob: 'like' });
    expect(stored.markdown).toBe('post p1');
  });

  it('stores only the bare tabs - a filtered link is not stored', () => {
    expect(storedFeedKey({ feed: 'associations' })).toBe('feed:associations');
    expect(storedFeedKey({ feed: 'all', promo: 2024 })).toBeNull();
    expect(storedFeedKey({ feed: 'all', formation: 'ICM' })).toBeNull();
  });
});

describe('the stored first page', () => {
  it('reads back what the last answer stored, rights removed', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1', { canManage: true }), post('p2')]);

    const drawn = await readStoredFeedPage(storage, ALICE, ALL);
    expect(drawn?.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(drawn?.[0].canManage).toBeUndefined();
    expect(drawn?.[0].canVote).toBe(false);
  });

  it('is never drawn after a sign-out, and its bytes go at the next read', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);
    expect(currentFeedEpoch('alice')).not.toBeNull();

    clearUserLocally();
    expect(currentFeedEpoch('alice')).toBeNull();
    // Signed back in as the same account: the copy written before the sign-out is still not drawn.
    localStorage.setItem('canari_saved_user', 'alice');

    expect(await readStoredFeedPage(storage, ALICE, ALL)).toBeNull();
    expect(await storage.deleteFeedPages()).toBe(0);
  });

  it('is never drawn after a change of account', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);

    saveUserLocally({ id: 'bob' });
    saveUserLocally({ id: 'alice' });

    expect(await readStoredFeedPage(storage, ALICE, ALL)).toBeNull();
  });

  it('is ended by a 403 from the feed (the reader is outside the audience)', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);

    expect(isOutsideFeedAudience(new ApiRefusalError(403, null, 'post-service 403'))).toBe(true);

    expect(await readStoredFeedPage(storage, ALICE, ALL)).toBeNull();
  });

  it('refuses a page that names another account, and deletes every page', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);
    const epoch = currentFeedEpoch('alice');
    await storage.saveFeedPage(
      'feed:all',
      { owner: 'bob', epoch, key: 'feed:all', posts: [] },
      KEY
    );

    expect(await readStoredFeedPage(storage, ALICE, ALL)).toBeNull();
    expect(await storage.deleteFeedPages()).toBe(0);
  });

  it('is not written for an account this device is no longer signed in as', async () => {
    const storage = await openStore();
    localStorage.setItem('canari_saved_user', 'bob');

    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);

    expect(await storage.getFeedPage('feed:all', KEY)).toBeNull();
  });

  it('starts a new epoch after a sign-out and deletes the pages of the old one first', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, { feed: 'followed' }, [post('old')]);
    forgetStoredFeeds('test');

    await writeStoredFeedPage(storage, ALICE, ALL, [post('new')]);

    expect(await storage.getFeedPage('feed:followed', KEY)).toBeNull();
    expect((await readStoredFeedPage(storage, ALICE, ALL))?.map((p) => p.id)).toEqual(['new']);
  });
});

describe('the server page is authoritative for everything it could have returned', () => {
  const copy = [post('kept'), post('deleted'), post('no-longer-readable')];

  it('replaces a stored copy: a deleted or no longer readable post disappears', () => {
    const answer = [post('new'), post('kept')];
    expect(
      listAfterFirstPage({ answer, onScreen: copy, painted: null, fromStore: true })?.map(
        (p) => p.id
      )
    ).toEqual(['new', 'kept']);
  });

  it('withdraws every stored row on an empty answer', () => {
    expect(
      listAfterFirstPage({ answer: [], onScreen: copy, painted: null, fromStore: true })
    ).toEqual([]);
  });

  it('keeps the in-memory tab rule: a list the reader changed since the paint is not replaced', () => {
    const painted = [post('a')];
    const changed = [post('a'), post('b')];
    expect(
      listAfterFirstPage({ answer: [post('x')], onScreen: changed, painted, fromStore: false })
    ).toBeNull();
    expect(
      listAfterFirstPage({ answer: [post('x')], onScreen: painted, painted, fromStore: false })
    ).toEqual([post('x')]);
  });

  it('ends the copy on a 401 or 403 and keeps it on anything that is not an answer', () => {
    expect(feedRefusalEndsCopy(new ApiRefusalError(401, null, 'x'))).toBe(true);
    expect(feedRefusalEndsCopy(new ApiRefusalError(403, null, 'x'))).toBe(true);
    expect(feedRefusalEndsCopy(new ApiRefusalError(503, null, 'x'))).toBe(false);
    expect(feedRefusalEndsCopy(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('a stored page rewritten from the answer no longer holds the withdrawn posts', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, copy);
    await writeStoredFeedPage(storage, ALICE, ALL, []);
    expect(await readStoredFeedPage(storage, ALICE, ALL)).toEqual([]);
  });
});
