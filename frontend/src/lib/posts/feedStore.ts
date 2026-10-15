import { getStorage, type IStorage } from '$lib/db';
import type { PostEntity } from '$lib/posts/api';
import type { FeedCacheParams } from '$lib/posts/feedCache';
import { currentFeedEpoch, ensureFeedEpoch } from '$lib/posts/feedStoreEpoch';
import { getSavedUserId } from '$lib/stores/user';
import { refusalStatus } from '$lib/utils/apiRefusal';

/**
 * THE FEED'S STORED FIRST PAGE, DRAWN BEFORE THE SERVER ANSWERS (local-first feed, 2026-10-15).
 *
 * Offline, the feed said "Impossible de charger les posts" for posts the device had shown an hour
 * earlier. The first page each bare tab last received is now kept in the account's own database,
 * sealed under the device key like a salon's page (F4 of community-open-budget), and drawn at mount
 * while the server is asked. The server's answer REPLACES it: a first page could have returned every
 * row of the copy, so a row it does not name is gone (deleted, moderated, no longer readable, or
 * pushed below the first page). Design, rejected options and the privacy rules:
 * docs/wiki/frontend/modules/posts.md, "The feed is drawn from the device first".
 *
 * WHAT IT IS NOT. Never an authority, and never a holder of rights: every served `can*` verdict is
 * dropped before the page is sealed and `canVote` is stored as `false`, so a card drawn from the
 * device offers no control the server has not just confirmed.
 */

/** The served verdicts on the reader: every `canXxx` field of a post. */
const SERVED_RIGHT = /^can[A-Z]/;

/** One stored page, as sealed. `owner` and `key` repeat the slot's own coordinates on purpose. */
interface StoredFeedPage {
  owner: string;
  epoch: string;
  key: string;
  posts: PostEntity[];
}

/** What may decide whether the stored feed is readable now - every value the page already holds. */
export interface FeedStoreGateInput {
  /** The account on screen (`currentUserId()`). */
  currentUserId: string | null;
  /** The account the session's device key belongs to. */
  sessionUserId: string;
  /** The session's device key, `''` while none is in hand. */
  deviceKeyB64: string;
  /** The session is up (PIN or vault through, MLS initialised). */
  isLoggedIn: boolean;
  /** The account whose unlock prompts nobody (`unlockUnattendedFor()`), or `null`. */
  unattendedFor: string | null;
}

/** The account and key a stored feed is read and written with. */
export interface FeedStoreAccess {
  userId: string;
  deviceKeyB64: string;
}

/**
 * The account whose stored feed may be read and written now, with its key, or `null`.
 *
 * NOTHING IS DRAWN WHILE AN UNLOCK IS PENDING. A device that owes a PIN or a fingerprint is a locked
 * device: the copy is readable only once the session is up, or while this account's unlock prompts
 * nobody (the F1 fact, `stores/unlockPath.svelte.ts`) - and only with a key that belongs to the
 * account on screen.
 */
export function feedStoreAccess(input: FeedStoreGateInput): FeedStoreAccess | null {
  const userId = input.currentUserId;
  if (!userId || !input.deviceKeyB64 || input.sessionUserId !== userId) return null;
  if (!input.isLoggedIn && input.unattendedFor !== userId) return null;
  return { userId, deviceKeyB64: input.deviceKeyB64 };
}

/**
 * The slot a tab's first page is stored under, or `null` for a tab that is not stored.
 *
 * Only the bare tabs are: a `promo` or `formation` filter comes from a shared link, and storing every
 * filter a link ever named would make the store unbounded. Four tabs, four slots at most.
 */
export function storedFeedKey(params: FeedCacheParams): string | null {
  if (params.promo !== undefined || params.formation !== undefined) return null;
  return `feed:${params.feed}`;
}

/** A post as it may be stored: no served verdict on the reader, and no vote offered. */
export function storableFeedRow(post: PostEntity): PostEntity {
  const row: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(post)) {
    if (!SERVED_RIGHT.test(field)) row[field] = value;
  }
  // `canVote` reads ABSENT as "may vote" (`PostCard`), so it is the one verdict stored, as `false`:
  // a reader holding only a read grant must never be offered a vote from the copy.
  row.canVote = false;
  return row as unknown as PostEntity;
}

/** True when `value` has the shape of one stored post - enough to draw a card, nothing more. */
function isStoredPost(value: unknown): value is PostEntity {
  if (!value || typeof value !== 'object') return false;
  const post = value as Record<string, unknown>;
  return typeof post.id === 'string' && typeof post.publishedAt === 'string';
}

/**
 * Whether a failed feed read is an ANSWER that ends the stored copy: a `401` or a `403` says
 * something about this reader. A transport failure or a 5xx says nothing, and keeps the copy.
 */
export function feedRefusalEndsCopy(error: unknown): boolean {
  const status = refusalStatus(error);
  return status === 401 || status === 403;
}

/**
 * The list a tab shows once its first page answers, or `null` to keep what is on screen.
 *
 * A list drawn from the stored copy is REPLACED, whatever the reader sees: the copy is itself a first
 * page, so the answer could have returned every one of its rows, and a row it does not name is gone -
 * deleted, moderated, no longer readable by this reader, or pushed below the first page. An empty
 * answer withdraws them all. A list painted from the in-memory tab cache keeps its older rule: it is
 * replaced unless the reader has changed it since the paint (a page appended, a post deleted).
 */
export function listAfterFirstPage(input: {
  answer: PostEntity[];
  onScreen: PostEntity[] | null;
  painted: PostEntity[] | null;
  fromStore: boolean;
}): PostEntity[] | null {
  if (input.fromStore) return input.answer;
  return input.onScreen === input.painted ? input.answer : null;
}

/** Deletes every stored page, logging rather than throwing: it runs on a read or write path. */
async function deleteAllPages(storage: IStorage, why: string): Promise<void> {
  try {
    const deleted = await storage.deleteFeedPages();
    console.log(`[FEED-STORE] ${deleted} stored feed page(s) deleted (${why})`);
  } catch (error) {
    console.warn(`[FEED-STORE] stored feed pages could not be deleted (${why}): ${String(error)}`);
  }
}

/**
 * The stored first page of a tab for `userId`, rights removed, or `null` when there is none.
 *
 * A page that does not have the stored shape, names another account or another tab, or carries an
 * epoch that is not the account's current one (a sign-out happened since) is not drawn: EVERY stored
 * page is deleted, and the reason logged.
 */
export async function readStoredFeedPage(
  storage: IStorage,
  access: FeedStoreAccess,
  params: FeedCacheParams
): Promise<PostEntity[] | null> {
  const key = storedFeedKey(params);
  if (!key) return null;
  const payload = (await storage.getFeedPage(key, access.deviceKeyB64)) as Partial<StoredFeedPage>;
  if (payload === null || payload === undefined) return null;

  const valid =
    typeof payload === 'object' &&
    payload.owner === access.userId &&
    payload.key === key &&
    typeof payload.epoch === 'string' &&
    Array.isArray(payload.posts) &&
    payload.posts.every(isStoredPost);
  if (!valid) {
    console.warn(
      `[FEED-STORE] the stored ${key} page is not one this build wrote for this account - every stored page deleted`
    );
    await deleteAllPages(storage, 'foreign or malformed page');
    return null;
  }
  if (payload.epoch !== currentFeedEpoch(access.userId)) {
    console.log(
      `[FEED-STORE] the stored ${key} page predates a sign-out or a refusal - not drawn, every stored page deleted`
    );
    await deleteAllPages(storage, 'ended epoch');
    return null;
  }
  return payload.posts!.map(storableFeedRow);
}

/**
 * Stores `posts` as the tab's first page for `userId`, replacing the previous one.
 *
 * Refused (and logged) when the device's sign-in record names another account or nobody: a tab still
 * showing an account another tab signed out must not write that account's feed back. The first write
 * of a new epoch deletes every older page first.
 */
export async function writeStoredFeedPage(
  storage: IStorage,
  access: FeedStoreAccess,
  params: FeedCacheParams,
  posts: readonly PostEntity[]
): Promise<void> {
  const key = storedFeedKey(params);
  if (!key) return;
  if (getSavedUserId() !== access.userId) {
    console.warn(
      `[FEED-STORE] ${key} not stored - this device is no longer signed in as the account on screen`
    );
    return;
  }
  const epoch = ensureFeedEpoch(access.userId);
  if (!epoch) return;
  if (epoch.started) await deleteAllPages(storage, 'new epoch');
  const page: StoredFeedPage = {
    owner: access.userId,
    epoch: epoch.epoch,
    key,
    posts: posts.map(storableFeedRow),
  };
  await storage.saveFeedPage(key, page, access.deviceKeyB64);
}

/**
 * {@link readStoredFeedPage} on the account's open store. Never throws: a store that cannot be
 * opened or read is logged, and the feed waits for the server as it always did.
 */
export async function loadStoredFeed(
  access: FeedStoreAccess,
  params: FeedCacheParams
): Promise<PostEntity[] | null> {
  if (!storedFeedKey(params)) return null;
  try {
    return await readStoredFeedPage(await getStorage(access.userId), access, params);
  } catch (error) {
    console.warn(`[FEED-STORE] the stored feed could not be read: ${String(error)}`);
    return null;
  }
}

/**
 * {@link writeStoredFeedPage} on the account's open store. Never throws: a store that refuses the
 * write is logged, and the next launch waits for the server.
 */
export async function saveStoredFeed(
  access: FeedStoreAccess,
  params: FeedCacheParams,
  posts: readonly PostEntity[]
): Promise<void> {
  if (!storedFeedKey(params)) return;
  try {
    await writeStoredFeedPage(await getStorage(access.userId), access, params, posts);
  } catch (error) {
    console.warn(`[FEED-STORE] the feed could not be stored: ${String(error)}`);
  }
}
