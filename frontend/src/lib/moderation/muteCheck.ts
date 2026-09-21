import { getMyMuteStatus } from './api';

const CACHE_TTL_MS = 5 * 60_000;

let cachedAt = 0;
let cached: { isMuted: boolean; mutedReason: string | null } | null = null;

/** Returns the current user's mute status, cached for 5 minutes. */
export async function getMuteStatus(): Promise<{ isMuted: boolean; mutedReason: string | null }> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  const s = await getMyMuteStatus();
  cached = { isMuted: s.isMuted, mutedReason: s.mutedReason };
  cachedAt = Date.now();
  return cached;
}

/**
 * Moderation refused this write, said as a type.
 *
 * THE MESSAGE IS DEV PROSE, NOT THE READER'S SENTENCE, which is why this is NOT a `LocalizedError`
 * and why it has to be something: a caller must be able to tell "you are restricted" from "the
 * server could not be reached to ask", and both used to leave {@link assertNotMuted} as a bare
 * `Error`. One caller told them apart by not trying - `CreatePostForm` showed the same "could not
 * publish" for a muted account and for a dead radio, which is the report that produced this type
 * (2026-09-21). **Classify at the THROW, as a type**, and let each screen map it to its own line.
 *
 * `mutedReason` rides along because the moderator wrote it for the reader and no screen has ever
 * shown it. Nothing renders it yet - a moderator's free text is not a translated sentence and does
 * not become one by being displayed - but the caller that decides to can now reach it without
 * splitting a message.
 */
export class MutedError extends Error {
  constructor(readonly mutedReason: string | null) {
    super(`This account is restricted by moderation${mutedReason ? ` : ${mutedReason}` : '.'}`);
    this.name = 'MutedError';
  }
}

/**
 * Throws {@link MutedError} when the current user is muted. Call at the start of any write action
 * (post, comment, reaction).
 *
 * IT ASKS THE SERVER, so it can also reject with whatever `apiFetch` rejected with - a transport
 * failure, an expired session. That is not a refusal and must not be read as one: only
 * `instanceof MutedError` means "moderation said no".
 */
export async function assertNotMuted(): Promise<void> {
  const { isMuted, mutedReason } = await getMuteStatus();
  if (!isMuted) return;
  throw new MutedError(mutedReason);
}

/** Resets the cache (call after a moderation status change). */
export function invalidateMuteCache(): void {
  cached = null;
  cachedAt = 0;
}
