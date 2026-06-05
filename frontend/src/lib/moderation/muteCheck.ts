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
 * Throws a user-readable error when the current user is muted.
 * Call at the start of any write action (post, comment, reaction).
 */
export async function assertNotMuted(): Promise<void> {
  const { isMuted, mutedReason } = await getMuteStatus();
  if (!isMuted) return;
  const suffix = mutedReason ? ` : ${mutedReason}` : '.';
  throw new Error(`Votre compte est restreint par la modération${suffix}`);
}

/** Resets the cache (call after a moderation status change). */
export function invalidateMuteCache(): void {
  cached = null;
  cachedAt = 0;
}
