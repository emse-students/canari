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
 * they were accepted (the followers list) - since when the row means what the list says.
 */
export interface FollowListEntry {
  userId: string;
  createdAt: string;
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

/** The requests waiting for the reader's answer, newest first. */
export async function listFollowRequests(limit = 100, offset = 0): Promise<FollowListEntry[]> {
  return socialRequest<FollowListEntry[]>(
    `/api/posts/me/follow-requests?limit=${limit}&offset=${offset}`
  );
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

/** The reader's own followers, the most recently accepted first. */
export async function listFollowers(limit = 100, offset = 0): Promise<FollowListEntry[]> {
  return socialRequest<FollowListEntry[]>(
    `/api/posts/me/followers?limit=${limit}&offset=${offset}`
  );
}

/** Removes `userId` from the reader's followers; nobody is told. */
export async function removeFollower(userId: string): Promise<void> {
  Log.d('follows', `remove follower ${userId.slice(0, 8)}`);
  await socialRequest(`/api/posts/me/followers/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

/** The requests the reader sent that nobody has answered yet, newest first. */
export async function listSentFollowRequests(limit = 100, offset = 0): Promise<FollowListEntry[]> {
  return socialRequest<FollowListEntry[]>(
    `/api/posts/me/follow-requests/sent?limit=${limit}&offset=${offset}`
  );
}
