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
 * Throws when the current user is muted. Call at the start of any write action (post, comment,
 * reaction).
 *
 * THE MESSAGE IS DEV PROSE, NOT THE READER'S SENTENCE, and it says so because the docblock used to
 * claim the opposite. Every caller catches this and renders a Paraglide line of its own
 * (`m.post_action_not_allowed()`, `m.post_create_publish_error()`), so nothing here has ever
 * reached a screen - which is also why the moderator's own `mutedReason` never does. Saying that
 * out loud is the point: an error whose message IS for the reader is a `LocalizedError`, and this
 * is not one. See `utils/localizedError.ts`.
 */
export async function assertNotMuted(): Promise<void> {
  const { isMuted, mutedReason } = await getMuteStatus();
  if (!isMuted) return;
  const suffix = mutedReason ? ` : ${mutedReason}` : '.';
  throw new Error(`This account is restricted by moderation${suffix}`);
}

/** Resets the cache (call after a moderation status change). */
export function invalidateMuteCache(): void {
  cached = null;
  cachedAt = 0;
}
