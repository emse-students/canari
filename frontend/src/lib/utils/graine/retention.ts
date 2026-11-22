import { isGraineReady, requireGraineRuntime, forgetGraineSeedCache } from './runtime';
import { forgetAskedSession } from './repair';
import { forgetGraineMirroredSessions } from './graineMirror';
import { channelService } from '$lib/services/ChannelService';
import { onAppForegroundChange } from '$lib/utils/appForeground';

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
 * The shortest window this device will sweep with, whatever the server answers: the product's own
 * message retention, `CHANNEL_MESSAGE_RETENTION_DAYS` = 365 (`docs/wiki/protocols/channel-encryption.md`,
 * section 8).
 *
 * The server still OWNS the window - this is a client-side bound on a server-provided value, not a
 * second copy of it. An honest server answers exactly this, so the bound changes nothing; a server
 * answering less would make every device drop every seed older than its answer, and seeds are the
 * only thing that opens a salon's history. A deletion driven by a remote number gets a local floor.
 *
 * There is deliberately NO ceiling: a ceiling would only ever delete SOONER than the server says,
 * and the server already decides which sessions are live, so a ceiling bounds nothing it could not
 * route around while costing history if the product window is ever lengthened.
 *
 * Shortening the product window therefore means lowering this floor in the same change;
 * `retentionFloorPin.test.ts` fails the moment the two numbers differ.
 */
export const GRAINE_RETENTION_FLOOR_DAYS = 365;

/**
 * Bounds the server's `retentionDays` from below by {@link GRAINE_RETENTION_FLOOR_DAYS}.
 *
 * @returns The window to sweep with, or `null` when the answer is not a finite number - there is no
 *   value to bound, so the sweep refuses rather than inventing one.
 */
export function boundGraineRetentionDays(serverDays: number): number | null {
  if (typeof serverDays !== 'number' || !Number.isFinite(serverDays)) {
    console.error(
      `[GRAINE] retention sweep refused - the server answered retentionDays=${String(serverDays)}, not a number of days`
    );
    return null;
  }
  if (serverDays < GRAINE_RETENTION_FLOOR_DAYS) {
    // Accuses: an honest server answers the product window, so this is a server that is wrong or
    // hostile, and the clamp is what keeps it from wiping the history of every salon on this device.
    // A server stuck in that state gets this line on EVERY sweep, deliberately: it is not a one-off
    // to be remembered and silenced, it is a standing fault, and a line that stopped repeating would
    // read as a server that had been fixed.
    console.error(
      `[GRAINE] retention sweep clamped - the server answered retentionDays=${serverDays}, below the client floor of ${GRAINE_RETENTION_FLOOR_DAYS}; sweeping with the floor`
    );
    return GRAINE_RETENTION_FLOOR_DAYS;
  }
  return serverDays;
}

/**
 * Asks the server which held sessions are still alive and forgets the rest.
 *
 * **A session younger than the retention window is never dropped, whatever the server answers.**
 * "No message names this session" has two causes the answer cannot separate: its messages expired,
 * or it has none yet - a session minted seconds ago, or one whose first send has not landed. Only
 * the first is a reason to delete, and age is what tells them apart. The window comes back with the
 * answer for this, bounded from below by {@link GRAINE_RETENTION_FLOOR_DAYS}.
 *
 * **Degrades rather than throws.** It runs as post-boot maintenance; a sweep that could not run
 * costs one more day of seeds that were already outliving their messages, and every branch that
 * gives up says so.
 *
 * @returns How many durable sessions were dropped; 0 when there was nothing to drop or nothing ran.
 */
export async function sweepExpiredGraineSeeds(): Promise<number> {
  const gen = sweepGeneration;
  if (!isGraineReady()) {
    console.warn('[GRAINE] retention sweep skipped - no Graine runtime is wired');
    return 0;
  }
  const { storage, userId } = requireGraineRuntime('sweepExpiredGraineSeeds');

  // Read the ENCRYPTED rows: this needs the session id and the creation date, never the seed, so
  // an undecryptable row is swept like any other rather than being the one thing that survives.
  let held: { sessionId: string; createdAt: number }[];
  try {
    const rows = await storage.getAllEncryptedGraineRows();
    held = rows.map((row) => ({ sessionId: row.sessionId, createdAt: row.createdAt }));
  } catch (e) {
    console.warn(`[GRAINE] retention sweep could not read the seed store: ${String(e)}`);
    return 0;
  }
  if (held.length === 0) return 0;

  // PROGRESS IS DURABLE, NOT HELD IN A VARIABLE. Each chunk is judged and its expired seeds dropped
  // before the next is asked: a chunk the server answered is a fact about those sessions alone, and
  // the rows it condemned are gone from the store, so the NEXT sweep starts from a shorter list. A
  // sweep abandoned at a late chunk used to throw away the answers of the earlier ones - and a device
  // holding 1,100 seeds on a flaky link never shrank at all.
  let dropped = 0;
  let liveCount = 0;
  for (let i = 0; i < held.length; i += LIVE_QUERY_CHUNK) {
    // The account that started this sweep logged out: its answers say nothing about the next one's.
    if (gen !== sweepGeneration) return dropped;
    const chunkRows = held.slice(i, i + LIVE_QUERY_CHUNK);
    let answer: { live: string[]; retentionDays: number };
    try {
      answer = await channelService.liveGraineSessions(chunkRows.map((s) => s.sessionId));
    } catch (e) {
      // A chunk that never got an answer is not swept (silence means nothing), but the chunks that
      // did answer have already been acted on, and the sweep is OWED until one run completes.
      if (gen === sweepGeneration) sweepOwed = true;
      console.warn(
        `[GRAINE] retention sweep interrupted after ${i} of ${held.length} session(s) (${dropped} dropped so far), resumes on the next foreground or connection: ${String(e)}`
      );
      return dropped;
    }
    // A window below the floor (zero and negative included) would make every session look old
    // enough, and the sweep would delete the seed of every salon this device has not yet posted in.
    const windowDays = boundGraineRetentionDays(answer.retentionDays);
    if (windowDays === null) {
      if (gen === sweepGeneration) sweepOwed = true;
      return dropped;
    }
    const live = new Set(answer.live);
    liveCount += live.size;
    const cutoff = Date.now() - windowDays * DAY_MS;
    const sessionIds = chunkRows
      .filter((s) => !live.has(s.sessionId) && s.createdAt < cutoff)
      .map((s) => s.sessionId);
    if (sessionIds.length === 0) continue;

    // Three stores, and none stands in for the others: the durable rows are what the app READS, the
    // native mirror is what a background push reads, and the in-memory cache is what this tab answers
    // from until it is reloaded. Leaving any one of them is a sweep that only looks complete.
    try {
      dropped += await storage.deleteGraineSessions(sessionIds);
    } catch (e) {
      if (gen === sweepGeneration) sweepOwed = true;
      console.warn(
        `[GRAINE] retention sweep failed to drop ${sessionIds.length} expired seed(s): ${String(e)}`
      );
      return dropped;
    }
    forgetGraineSeedCache(sessionIds);
    for (const sessionId of sessionIds) forgetAskedSession(sessionId, 'retention');
    await forgetGraineMirroredSessions(sessionIds, userId);
  }

  if (gen === sweepGeneration) sweepOwed = false;
  console.info(
    `[GRAINE] retention sweep dropped ${dropped} seed(s) whose messages are gone (held=${held.length}, live=${liveCount})`
  );
  return dropped;
}

/**
 * True while a sweep of THIS session stopped before the last chunk. Module state is enough: it is
 * not a decision about the seeds (the store is the truth about those), only about whether to ASK
 * again.
 */
let sweepOwed = false;

/**
 * Bumped on logout. A sweep started under an older value neither sets nor clears the owed flag and
 * stops at its next chunk, so a logout/login overlap cannot hand the next account a flag, or a
 * "running" latch, that belongs to the previous one.
 */
let sweepGeneration = 0;
let flight: { gen: number; promise: Promise<void> } | null = null;

/**
 * THE ONE ENTRANCE: the boot sweep and the resume both come through here, so two can never run at
 * once (they would ask the same chunks and race each other's deletes). A flight of an older session
 * does not block the current one.
 */
export function runGraineSweep(): Promise<void> {
  if (flight && flight.gen === sweepGeneration) return flight.promise;
  const gen = sweepGeneration;
  const promise = sweepExpiredGraineSeeds()
    .then(() => undefined)
    .catch((e: unknown) => {
      console.warn(`[GRAINE] retention sweep threw: ${String(e)}`);
    })
    .finally(() => {
      if (flight?.promise === promise) flight = null;
    });
  flight = { gen, promise };
  return promise;
}

/**
 * Runs the sweep when the previous one left work owed. Called on every foreground edge and every
 * connection regained, so the retry is driven by the events that make a failed request likely to
 * succeed - not by a timer.
 */
export async function resumeGraineSweepIfOwed(): Promise<void> {
  if (!sweepOwed || !isGraineReady()) return;
  await runGraineSweep();
}

/** Logout: forgets the owed flag and orphans any sweep still running for the account that left. */
export function resetGraineSweepState(): void {
  sweepGeneration++;
  sweepOwed = false;
  flight = null;
}

let resumeInstalled = false;

/**
 * Wires {@link resumeGraineSweepIfOwed} to the native foreground edge, the page becoming visible and
 * the connection coming back. Idempotent; the handlers are inert while nothing is owed or no Graine
 * runtime is wired, so they need no teardown on logout.
 */
export function installGraineSweepResume(): void {
  if (resumeInstalled || typeof window === 'undefined') return;
  resumeInstalled = true;
  const resume = () => void resumeGraineSweepIfOwed();
  onAppForegroundChange((foreground) => {
    if (foreground) resume();
  });
  window.addEventListener('online', resume);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });
}
