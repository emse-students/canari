/**
 * FOLLOWING A PERSON (WP-F1..F4): every personal account is private, so a follow of a person is a
 * REQUEST the person answers - from an inbox (`me/follow-requests`) - and their followers are a list
 * they can remove anybody from (`me/followers`). An association is followed elsewhere, at once
 * (`$lib/associations/api`).
 *
 * All of it lives on social-service under `/api/posts/...`, the prefix the follow routes always
 * had. A refusal is an `ApiRefusalError` carrying the server's `code` (read with `refusalCode`).
 */
import { socialRequest } from '$lib/posts/api';
import { Log } from '$lib/utils/Log';

/** Where the reader stands with a person: a request not answered yet, or a follow. */
export type FollowStatus = 'pending' | 'accepted';

/** The ask named an id that is no person: an association, a list, an institution, or nobody. */
export const FOLLOW_TARGET_NOT_FOUND = 'FOLLOW_TARGET_NOT_FOUND';
/** A block stands between the two, in either direction. */
export const FOLLOW_BLOCKED = 'FOLLOW_BLOCKED';
/** The asker already has 100 requests nobody answered (409): wait, or withdraw some. */
export const FOLLOW_PENDING_LIMIT = 'FOLLOW_PENDING_LIMIT';
/** The asker has asked 50 new people in the last day (429). */
export const FOLLOW_DAILY_LIMIT = 'FOLLOW_DAILY_LIMIT';

/**
 * One person in a follow list. `createdAt` is when they asked (the inbox, the sent list) or when
 * they were accepted (the followers list) - since when the row means what the list says. `cursor`
 * is opaque: the next page starts right after the row it names (`nextFollowCursor`). A server older
 * than the cursor paging sends none, and the list then ends at its first page.
 */
export interface FollowListEntry {
  userId: string;
  createdAt: string;
  cursor?: string;
}

/** How many people one page of a follow list holds - the server's `FOLLOW_PAGE_MAX`. */
export const FOLLOW_PAGE_SIZE = 100;

/**
 * Where the page after `page` starts, or `null` when `page` is the last one. A page shorter than
 * `FOLLOW_PAGE_SIZE` is the last (keyset paging: the server answered everything after the cursor
 * there is); a full one continues after its last row.
 */
export function nextFollowCursor(page: readonly FollowListEntry[]): string | null {
  if (page.length < FOLLOW_PAGE_SIZE) return null;
  return page[page.length - 1].cursor ?? null;
}

/** The query string of one page: the size, and where it starts when it is not the first. */
function pageQuery(after: string | undefined): string {
  const start = after ? `&after=${encodeURIComponent(after)}` : '';
  return `?limit=${FOLLOW_PAGE_SIZE}${start}`;
}

/**
 * Appends `page` to `list`, a person already listed kept once - a row answered or removed between
 * two pages never moves another one, but the guard keeps a re-read from showing a person twice.
 */
export function appendFollowPage(
  list: readonly FollowListEntry[],
  page: readonly FollowListEntry[]
): FollowListEntry[] {
  const seen = new Set(list.map((e) => e.userId));
  return [...list, ...page.filter((e) => !seen.has(e.userId))];
}

const user = (userId: string) => `/api/posts/users/${encodeURIComponent(userId)}`;

/** Asks to follow `userId`. Answers the status the pair is now in (an accepted follow stays one). */
export async function askToFollow(userId: string): Promise<FollowStatus> {
  Log.d('follows', `ask ${userId.slice(0, 8)}`);
  const { status } = await socialRequest<{ ok: boolean; status: FollowStatus }>(
    `${user(userId)}/follow`,
    { method: 'POST' }
  );
  return status;
}

/** Unfollows `userId`, or withdraws a request not answered yet. */
export async function leaveFollow(userId: string): Promise<void> {
  Log.d('follows', `leave ${userId.slice(0, 8)}`);
  await socialRequest<{ ok: boolean }>(`${user(userId)}/follow`, { method: 'DELETE' });
}

/** Where the reader stands with `userId`: `pending`, `accepted`, or `null` (neither). */
export async function getFollowStatus(userId: string): Promise<FollowStatus | null> {
  const { status } = await socialRequest<{ following: boolean; status: FollowStatus | null }>(
    `${user(userId)}/follow-status`
  );
  return status ?? null;
}

/** One page of the requests waiting for the reader's answer, newest first, after `after`. */
export async function listFollowRequests(after?: string): Promise<FollowListEntry[]> {
  return socialRequest<FollowListEntry[]>(`/api/posts/me/follow-requests${pageQuery(after)}`);
}

/** How many requests wait for the reader's answer. */
export async function countFollowRequests(): Promise<number> {
  const { pending } = await socialRequest<{ pending: number }>(
    '/api/posts/me/follow-requests/count'
  );
  return pending;
}

/** Accepts `userId`'s request: they follow the reader from now on. 404 when none is pending. */
export async function acceptFollowRequest(userId: string): Promise<void> {
  Log.d('follows', `accept ${userId.slice(0, 8)}`);
  await socialRequest(`/api/posts/me/follow-requests/${encodeURIComponent(userId)}/accept`, {
    method: 'POST',
  });
}

/** Refuses `userId`'s request: deleted, nobody is told. 404 when none is pending. */
export async function refuseFollowRequest(userId: string): Promise<void> {
  Log.d('follows', `refuse ${userId.slice(0, 8)}`);
  await socialRequest(`/api/posts/me/follow-requests/${encodeURIComponent(userId)}/refuse`, {
    method: 'POST',
  });
}

/** One page of the reader's own followers, the most recently accepted first, after `after`. */
export async function listFollowers(after?: string): Promise<FollowListEntry[]> {
  return socialRequest<FollowListEntry[]>(`/api/posts/me/followers${pageQuery(after)}`);
}

/** Removes `userId` from the reader's followers; nobody is told. */
export async function removeFollower(userId: string): Promise<void> {
  Log.d('follows', `remove follower ${userId.slice(0, 8)}`);
  await socialRequest(`/api/posts/me/followers/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

/** One page of the requests the reader sent and nobody answered yet, newest first, after `after`. */
export async function listSentFollowRequests(after?: string): Promise<FollowListEntry[]> {
  return socialRequest<FollowListEntry[]>(`/api/posts/me/follow-requests/sent${pageQuery(after)}`);
}
