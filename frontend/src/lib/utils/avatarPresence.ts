import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { registerPerReaderCache } from '$lib/utils/sharedCache';

/**
 * Whether a user has a profile photo, asked for a whole list at once - so a face without one is
 * never requested at all.
 *
 * WHY IT EXISTS (Mi 9T, 2026-10-13): a salon open requested the avatar of every member and learned
 * that a member has no photo by being refused - 37 `404`s in one walk, 25 of them in one open, each
 * a `Failed to load resource` line the page cannot silence. The gallery holds the fact, and
 * `GET /api/users/avatar-presence` states it for up to 100 ids in one answer (durable rule: never
 * learn by failing what a fact could have told you).
 *
 * WHAT IT COSTS: a face this session has never seen waits for that one answer before its own
 * request - one round trip, during which the initials are drawn anyway. A face seen once is
 * answered from {@link known} with no request.
 *
 * Remembered for the reader's session, like the absences in `userAvatarCache.ts` and for the same
 * reason: a photo added in MiGallery shows on the next load of the app, the cost that file already
 * accepts. `null` (the gallery could not say, or a server without the route) is NEVER remembered:
 * it is not an answer about anybody's photo, and the caller then requests the avatar as before.
 */
const known = new Map<string, boolean>();
registerPerReaderCache(() => known.clear());

/** Mirrors `MAX_PROFILE_BATCH` in `apps/core-service/src/users/users.controller.ts`. */
const PRESENCE_BATCH_MAX = 100;

type Waiter = (hasPhoto: boolean | null) => void;
let pendingBatch: Map<string, Waiter[]> | null = null;

/**
 * Whether `userId` has a photo: `true`, `false`, or `null` when nobody could say.
 *
 * Every id asked in the same turn of the event loop travels in one request (the window
 * `stores/user.ts` uses for profiles, and for its reason: a window, not a clock).
 */
export function avatarPhotoPresence(userId: string): Promise<boolean | null> {
  const remembered = known.get(userId);
  if (remembered !== undefined) return Promise.resolve(remembered);
  return new Promise<boolean | null>((resolve) => {
    if (!pendingBatch) {
      const batch = new Map<string, Waiter[]>();
      pendingBatch = batch;
      queueMicrotask(() => {
        pendingBatch = null;
        void flushPresenceBatch(batch);
      });
    }
    const waiters = pendingBatch.get(userId);
    if (waiters) waiters.push(resolve);
    else pendingBatch.set(userId, [resolve]);
  });
}

/** One request per chunk of the batch; every waiter is settled, whatever happened. */
async function flushPresenceBatch(batch: Map<string, Waiter[]>): Promise<void> {
  const ids = [...batch.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += PRESENCE_BATCH_MAX) {
    chunks.push(ids.slice(i, i + PRESENCE_BATCH_MAX));
  }
  await Promise.all(
    chunks.map(async (chunk) => {
      const answer = await askPresence(chunk);
      for (const id of chunk) {
        const hasPhoto = answer === null ? null : answer.has(id);
        if (hasPhoto !== null) known.set(id, hasPhoto);
        for (const resolve of batch.get(id) ?? []) resolve(hasPhoto);
      }
    })
  );
}

/** The ids of `chunk` that have a photo, or `null` when the answer is not one. Never throws. */
async function askPresence(chunk: string[]): Promise<Set<string> | null> {
  try {
    const res = await apiFetch(
      `${coreUrl()}/api/users/avatar-presence?ids=${chunk.map(encodeURIComponent).join(',')}`
    );
    if (!res.ok) {
      // A server before this route routes it as a profile id and answers 404; nothing to learn.
      Log.d(
        'AvatarPresence',
        `HTTP ${res.status} for ${chunk.length} id(s) - each avatar is asked`
      );
      return null;
    }
    const { withPhoto } = (await res.json()) as { withPhoto?: unknown };
    if (!Array.isArray(withPhoto)) {
      Log.d(
        'AvatarPresence',
        `the gallery could not say for ${chunk.length} id(s) - each avatar is asked`
      );
      return null;
    }
    const present = new Set(withPhoto.filter((id): id is string => typeof id === 'string'));
    Log.d(
      'AvatarPresence',
      `${chunk.length - present.size} of ${chunk.length} have no photo - not requested`
    );
    return present;
  } catch (e) {
    Log.d(
      'AvatarPresence',
      `could not ask for ${chunk.length} id(s): ${String(e)} - each avatar is asked`
    );
    return null;
  }
}
