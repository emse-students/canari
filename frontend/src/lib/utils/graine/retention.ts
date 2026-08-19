import { isGraineReady, requireGraineRuntime, forgetGraineSeedCache } from './runtime';
import { forgetAskedSession } from './repair';
import { forgetGraineMirroredSessions } from './graineMirror';
import { channelService } from '$lib/services/ChannelService';

/**
 * Drops the Graine seeds whose messages the server no longer has.
 *
 * Community messages expire after a retention window, and a seed that outlives its messages is
 * plaintext key material for content that no longer exists - a liability that grows for ever, on a
 * device and in an app-private native file. The window is ONE number and it lives on the server:
 * this sweep does not re-implement it, it ASKS. The device sends the session ids it holds and the
 * server answers which of them are still named by a stored message.
 *
 * Deriving liveness from the message rows rather than from a matching client-side timer is what
 * makes the two windows one. A pinned message is exempt from the purge, so it keeps naming its
 * session, so its seed is kept - a second clock would have deleted that seed and turned a
 * deliberately preserved message into ciphertext nobody holds the key to.
 *
 * Protocol: `docs/wiki/protocols/channel-encryption.md`.
 */

/**
 * Session ids per request. The server refuses anything larger rather than truncating it (a
 * truncated answer would read as "the rest are dead" and cost live seeds), so a mismatch with its
 * `MAX_LIVE_SESSION_QUERY` fails loudly on the first chunk instead of quietly deleting.
 */
const LIVE_QUERY_CHUNK = 500;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Asks the server which held sessions are still alive and forgets the rest.
 *
 * **A session younger than the retention window is never dropped, whatever the server answers.**
 * "No message names this session" has two causes the answer cannot separate: its messages expired,
 * or it has none yet - a session minted seconds ago, or one whose first send has not landed. Only
 * the first is a reason to delete, and age is what tells them apart. The window comes back with the
 * answer for this, so the client still holds no copy of it.
 *
 * **Degrades rather than throws.** It runs as post-boot maintenance; a sweep that could not run
 * costs one more day of seeds that were already outliving their messages, and every branch that
 * gives up says so.
 *
 * @returns How many durable sessions were dropped; 0 when there was nothing to drop or nothing ran.
 */
export async function sweepExpiredGraineSeeds(): Promise<number> {
  if (!isGraineReady()) {
    console.warn('[GRAINE] retention sweep skipped - no Graine runtime is wired');
    return 0;
  }
  const { storage } = requireGraineRuntime('sweepExpiredGraineSeeds');

  // Read the ENCRYPTED rows: this needs the session id and the creation date, never the seed, so
  // an undecryptable row is swept like any other rather than being the one thing that survives.
  let held: { sessionId: string; createdAt: number }[];
  try {
    const rows = await storage.getAllEncryptedGraineRows();
    held = rows.map((row) => ({ sessionId: row.sessionId, createdAt: row.createdAt }));
  } catch (e) {
    console.warn(
      `[GRAINE] retention sweep could not read the seed store: ${e instanceof Error ? e.message : String(e)}`
    );
    return 0;
  }
  if (held.length === 0) return 0;

  const live = new Set<string>();
  let retentionDays = 0;
  for (let i = 0; i < held.length; i += LIVE_QUERY_CHUNK) {
    const chunk = held.slice(i, i + LIVE_QUERY_CHUNK).map((s) => s.sessionId);
    let answer: { live: string[]; retentionDays: number };
    try {
      answer = await channelService.liveGraineSessions(chunk);
    } catch (e) {
      // A chunk that never got an answer must not be swept: the rest of this run would read its
      // sessions as unnamed, which is precisely the "server said nothing" that means nothing.
      console.warn(
        `[GRAINE] retention sweep abandoned after ${i} of ${held.length} session(s): ${e instanceof Error ? e.message : String(e)}`
      );
      return 0;
    }
    for (const sessionId of answer.live) live.add(sessionId);
    retentionDays = answer.retentionDays;
  }

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    // Fail closed. Without a window every session looks old enough, and the sweep would delete the
    // seed of every salon this device has not yet posted in.
    console.warn(
      `[GRAINE] retention sweep refused - the server answered retentionDays=${retentionDays}`
    );
    return 0;
  }

  const cutoff = Date.now() - retentionDays * DAY_MS;
  const doomed = held.filter((s) => !live.has(s.sessionId) && s.createdAt < cutoff);
  if (doomed.length === 0) return 0;

  const sessionIds = doomed.map((s) => s.sessionId);

  // Three stores, and none stands in for the others: the durable rows are what the app READS, the
  // native mirror is what a background push reads, and the in-memory cache is what this tab answers
  // from until it is reloaded. Leaving any one of them is a sweep that only looks complete.
  let dropped = 0;
  try {
    dropped = await storage.deleteGraineSessions(sessionIds);
  } catch (e) {
    console.warn(
      `[GRAINE] retention sweep failed to drop ${sessionIds.length} expired seed(s): ${e instanceof Error ? e.message : String(e)}`
    );
    return 0;
  }

  forgetGraineSeedCache(sessionIds);
  for (const sessionId of sessionIds) forgetAskedSession(sessionId);
  await forgetGraineMirroredSessions(sessionIds);

  console.info(
    `[GRAINE] retention sweep dropped ${dropped} seed(s) older than ${retentionDays} days whose messages are gone (held=${held.length}, live=${live.size})`
  );
  return dropped;
}
