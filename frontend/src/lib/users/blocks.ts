import { apiFetch, type ApiFetchOptions } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';

/** One person the signed-in user has blocked. */
export interface BlockedUser {
  userId: string;
  displayName: string | null;
  createdAt: string;
}

/**
 * The `code` a server sends when a mutation is refused because a block stands between two people.
 *
 * Both refusing services answer with it - `addGroupMember` in chat-delivery-service and the salon
 * invitation in social-service - so a caller tells this refusal from any other by the code and never
 * by the wording. The message itself is deliberately neutral: it says the person cannot be added, it
 * never says who blocked whom.
 */
export const USER_BLOCKED_CODE = 'USER_BLOCKED';

/** Reads the `code` out of an error body, whatever shape the failing service answered with. */
export function refusalCodeOf(body: string): string | null {
  try {
    return (JSON.parse(body) as { code?: string }).code ?? null;
  } catch {
    // Plain-text bodies come back from nginx and from some framework paths. The status still
    // classifies the failure, so a missing code is a missing discriminator, not a failure to report.
    return null;
  }
}

async function request<T>(path: string, init: ApiFetchOptions = {}): Promise<T> {
  const res = await apiFetch(`${coreUrl()}${path}`, init);
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`blocks ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as T;
}

/** The people the signed-in user has blocked, newest first. */
export async function listBlockedUsers(): Promise<BlockedUser[]> {
  Log.d('blocks.listBlockedUsers');
  return request<BlockedUser[]>('/api/users/me/blocks');
}

/**
 * Blocks a person. Idempotent - blocking twice is the same block.
 *
 * They are not notified, and no moderator is either. The two accounts stop finding each other in
 * target pickers, neither can open a 1-to-1 with the other and neither can pull the other into a
 * group or a private salon. Everything that already exists - conversations, groups, communities,
 * posts - is untouched.
 */
export async function blockUser(userId: string): Promise<{ ok: true }> {
  Log.d('blocks.blockUser', userId);
  return request<{ ok: true }>('/api/users/me/blocks', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

/** Lifts a block. Only the person who set it can. */
export async function unblockUser(userId: string): Promise<{ ok: true }> {
  Log.d('blocks.unblockUser', userId);
  return request<{ ok: true }>(`/api/users/me/blocks/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

/**
 * Whether a block stands between the signed-in user and `userId`, in either direction.
 *
 * ASKED BEFORE A CONVERSATION IS BUILT, never after. The authoritative refusal lives at the
 * mutation - `addGroupMember` on chat-delivery-service answers 403 `USER_BLOCKED` - but reaching it
 * means a group has already been minted and Welcomes already delivered, which leaves a half-built
 * conversation nobody asked for. The server knows the answer up front, so the creation paths ask.
 *
 * A failure to ASK is not an answer: this throws rather than returning `false`, so a caller cannot
 * mistake an unreachable core-service for "there is no block".
 */
export async function isBlockedWith(userId: string): Promise<boolean> {
  const { blocked } = await request<{ blocked: boolean }>(
    `/api/users/${encodeURIComponent(userId)}/block-status`
  );
  Log.d('blocks.isBlockedWith', { userId, blocked });
  return blocked;
}
