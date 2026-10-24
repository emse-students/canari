// @vitest-environment happy-dom
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
import { isOutsideFeedAudience, revalidateFeedAudience } from '$lib/posts/feedAudience';
import { fetchFeedAudience } from '$lib/posts/api';
import {
  feedMayLoadMore,
  feedRefetchOnReconnect,
  feedRefusalEndsCopy,
  feedStoreAccess,
  feedWriteEpoch,
  firstPageFailure,
  listAfterFirstPage,
  readStoredFeedPage,
  refreshFirstPage,
  saveStoredFeed,
  storableFeedRow,
  storedCopyMayDraw,
  storedFeedKey,
  writeStoredFeedPage as writePage,
  type FeedStoreAccess,
  type FirstPageState,
} from './feedStore';
import { currentFeedEpoch, forgetStoredFeeds } from './feedStoreEpoch';
import { getStorage } from '$lib/db';
import type { IStorage } from '$lib/db/types';

vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  fetchFeedAudience: vi.fn(),
}));
// `saveStoredFeed` is called for real below, with the account's store handed over when the test says.
vi.mock('$lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/db')>()),
  getStorage: vi.fn(),
}));

/** A write as `saveStoredFeed` makes it: the epoch decided first, then the store written. */
async function writeStoredFeedPage(
  storage: IndexedDbStorage,
  access: FeedStoreAccess,
  params: { feed: 'all' | 'followed' | 'associations' },
  posts: PostEntity[]
): Promise<void> {
  const epoch = feedWriteEpoch(access.userId, storedFeedKey(params)!);
  if (epoch) await writePage(storage, access, params, posts, epoch);
}

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const ALICE: FeedStoreAccess = { userId: 'alice', deviceKeyB64: KEY };
const ALL = { feed: 'all' as const };
const FOLLOWED = { feed: 'followed' as const };
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
      canRequestRepublication: true,
      republicationRequests: [
        { associationId: 'a2', associationName: 'A2', proposalId: 'r1', status: 'pending' },
      ],
      canVote: true,
      reactions: { bob: 'like' },
    });
    const stored = storableFeedRow(served);
    expect(Object.keys(stored).filter((k) => /^can[A-Z]/.test(k))).toEqual(['canVote']);
    expect(stored.republicationRequests).toBeUndefined();
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

describe('ended by what the device learns, and never revived by a write already waiting', () => {
  it('an audience verdict of false ends the copy', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);
    vi.mocked(fetchFeedAudience).mockResolvedValue({ inAudience: false });

    expect(await revalidateFeedAudience()).toBe(false);

    expect(currentFeedEpoch('alice')).toBeNull();
    expect(await readStoredFeedPage(storage, ALICE, ALL)).toBeNull();
  });

  it('an audience verdict of true keeps it', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);
    vi.mocked(fetchFeedAudience).mockResolvedValue({ inAudience: true });

    await revalidateFeedAudience();

    expect((await readStoredFeedPage(storage, ALICE, ALL))?.map((p) => p.id)).toEqual(['p1']);
  });

  it('a refusal while a write waits for the store leaves nothing drawable', async () => {
    const storage = await openStore();
    // The write decides its epoch, then waits for the store; the refusal lands in between.
    const epoch = feedWriteEpoch('alice', 'feed:all')!;
    firstPageFailure(new ApiRefusalError(403, null, 'post-service 403'), true);
    await writePage(storage, ALICE, ALL, [post('p1')], epoch);

    expect(currentFeedEpoch('alice')).toBeNull();
    expect(await readStoredFeedPage(storage, ALICE, ALL)).toBeNull();
  });

  it('saveStoredFeed: a refusal while the store is still opening leaves nothing drawable', async () => {
    const storage = await openStore();
    const opening = Promise.withResolvers<IStorage>();
    vi.mocked(getStorage).mockReturnValueOnce(opening.promise);

    const saving = saveStoredFeed(ALICE, ALL, [post('p1')]);
    // The refusal lands while `getStorage` is still being awaited.
    firstPageFailure(new ApiRefusalError(403, null, 'post-service 403'), true);
    opening.resolve(storage);
    await saving;

    expect(currentFeedEpoch('alice')).toBeNull();
    expect(await storage.getFeedPage('feed:all', KEY)).toBeNull();
  });

  it('saveStoredFeed: a write from before a refusal does not make the next read delete a fresh page', async () => {
    const storage = await openStore();
    vi.mocked(getStorage).mockResolvedValue(storage);
    await saveStoredFeed(ALICE, ALL, [post('p1')]);

    // A refresh of "all" takes the current epoch, then waits for the store...
    const opening = Promise.withResolvers<IStorage>();
    vi.mocked(getStorage).mockReturnValueOnce(opening.promise);
    const stale = saveStoredFeed(ALICE, ALL, [post('p-stale')]);
    // ...a refusal ends that epoch, and the next answer is stored under a new one...
    firstPageFailure(new ApiRefusalError(403, null, 'post-service 403'), true);
    await saveStoredFeed(ALICE, FOLLOWED, [post('p-new')]);
    // ...then the stale write gets its store.
    opening.resolve(storage);
    await stale;

    expect(await readStoredFeedPage(storage, ALICE, ALL)).toBeNull();
    expect((await readStoredFeedPage(storage, ALICE, FOLLOWED))?.map((p) => p.id)).toEqual([
      'p-new',
    ]);
  });

  it('a page this device can no longer open is deleted, so no later launch meets it again', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);
    const after = { ...ALICE, deviceKeyB64: OTHER_KEY };

    expect(await readStoredFeedPage(storage, after, ALL)).toBeNull();
    expect(await storage.getFeedPage('feed:all', OTHER_KEY)).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('the page wiring, as decisions', () => {
  it('draws the copy while the request is pending or failed, never once answered or refused or over a list', () => {
    expect(storedCopyMayDraw({ firstPage: 'pending', onScreen: null })).toBe(true);
    expect(storedCopyMayDraw({ firstPage: 'failed', onScreen: null })).toBe(true);
    expect(storedCopyMayDraw({ firstPage: 'answered', onScreen: null })).toBe(false);
    expect(storedCopyMayDraw({ firstPage: 'refused', onScreen: null })).toBe(false);
    expect(storedCopyMayDraw({ firstPage: 'pending', onScreen: [post('a')] })).toBe(false);
  });

  it('a refusal ends every stored page and withdraws a copy on screen', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);

    expect(firstPageFailure(new ApiRefusalError(401, null, 'x'), true)).toEqual({
      firstPage: 'refused',
      withdrawCopy: true,
      copyUnconfirmed: false,
    });
    expect(await readStoredFeedPage(storage, ALICE, ALL)).toBeNull();
  });

  it('a transport failure keeps the copy, unconfirmed, and ends nothing', async () => {
    const storage = await openStore();
    await writeStoredFeedPage(storage, ALICE, ALL, [post('p1')]);

    expect(firstPageFailure(new TypeError('Failed to fetch'), true)).toEqual({
      firstPage: 'failed',
      withdrawCopy: false,
      copyUnconfirmed: true,
    });
    expect(firstPageFailure(new ApiRefusalError(503, null, 'x'), false).copyUnconfirmed).toBe(
      false
    );
    expect((await readStoredFeedPage(storage, ALICE, ALL))?.map((p) => p.id)).toEqual(['p1']);
  });

  it('the infinite scroll asks nothing while the copy is on screen', () => {
    expect(feedMayLoadMore({ loadingMore: false, hasMore: true, fromStore: true })).toBe(false);
    expect(feedMayLoadMore({ loadingMore: false, hasMore: true, fromStore: false })).toBe(true);
    expect(feedMayLoadMore({ loadingMore: true, hasMore: true, fromStore: false })).toBe(false);
  });

  // Review of the reconnect refresh: the page read `data.feedParams` AFTER its await, so a refresh of
  // one tab landing after a switch was drawn over the next tab and written into its cache and store.
  it('a refresh asks for the tab it was issued for, and drops an answer for a tab left since', async () => {
    const followed = { feed: 'followed' as const };
    let current = 1;
    let answer!: (rows: PostEntity[]) => void;
    const read = vi.fn(
      () =>
        new Promise<PostEntity[]>((resolve) => {
          answer = resolve;
        })
    );
    const issued = 1;
    const pending = refreshFirstPage({
      params: followed,
      read,
      stillCurrent: () => current === issued,
    });
    expect(read).toHaveBeenCalledWith(followed);
    current = 2; // the reader switched tab while the request was out
    answer([post('p1')]);
    expect(await pending).toEqual({ kind: 'stale' });

    const failing = refreshFirstPage({
      params: followed,
      read: () => Promise.reject(new TypeError('Failed to fetch')),
      stillCurrent: () => false,
    });
    expect(await failing).toEqual({ kind: 'stale' });

    const kept = await refreshFirstPage({
      params: followed,
      read: async () => [post('p2')],
      stillCurrent: () => true,
    });
    expect(kept).toMatchObject({ kind: 'answered', params: followed });
  });

  // Mi 9T, `v1.2.9-alpha.1` (2026-10-15): after an offline start the copy still said "pas de
  // reponse du serveur" 40 s after the server was reachable again; only "Reessayer" replaced it.
  it('a confirmed reconnect asks again for a first page that got no answer', () => {
    const at = (firstPage: FirstPageState, loading = false, serverReachable = true) =>
      feedRefetchOnReconnect({ firstPage, loading, serverReachable });
    expect(at('failed')).toBe(true);
    // An answer is current, a refusal is an answer about the reader, a pending request will land.
    expect(at('answered')).toBe(false);
    expect(at('refused')).toBe(false);
    expect(at('pending')).toBe(false);
    // One request at a time, and the browser's `online` event alone proves nothing.
    expect(at('failed', true)).toBe(false);
    expect(at('failed', false, false)).toBe(false);
  });
});
