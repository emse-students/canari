import { getMyMuteStatus } from './api';

const CACHE_TTL_MS = 5 * 60_000;

let cachedAt = 0;
let cached: MuteStatus | null = null;
/**
 * The request being made right now, so two taps in the same second are one round trip.
 *
 * The cache below covered the SECOND five minutes and never the first tap of each window - and a
 * reader reacting, then commenting, then reacting again does all three inside it. On a bad link
 * that was three identical `GET /api/moderation/me/mute-status` racing each other.
 */
let inFlight: Promise<MuteStatus> | null = null;

export interface MuteStatus {
  isMuted: boolean;
  mutedReason: string | null;
}

/** Returns the current user's mute status, cached for 5 minutes. */
export async function getMuteStatus(): Promise<MuteStatus> {
  const fresh = cachedMuteStatus();
  if (fresh) return fresh;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const s = await getMyMuteStatus();
    cached = { isMuted: s.isMuted, mutedReason: s.mutedReason };
    cachedAt = Date.now();
    return cached;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * The mute status ALREADY KNOWN, without asking - or `null` when nothing fresh is held.
 *
 * WHAT IT IS FOR. A write path must not be sent to a server that is certain to refuse it, so the
 * check stays. But it must not put a round trip in front of a tap either, and in the overwhelming
 * majority of taps the answer is already here. A caller reads this first, moves the interface, and
 * only awaits when it genuinely has never been told.
 */
export function cachedMuteStatus(): MuteStatus | null {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  return null;
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
  inFlight = null;
}
