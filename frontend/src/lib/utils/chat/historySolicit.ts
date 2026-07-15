import type { IMlsService } from '$lib/mls-client/IMlsService';
import {
  markAwaitingHistory,
  clearAwaitingHistory,
  enumerateAwaitingHistory,
} from './awaitingHistoryRegistry';

/**
 * Bounded backoff (ms) for re-soliciting a history bundle after a fresh join. Kept short enough to
 * ride out a peer that is briefly away, bounded so a group whose only other member stays offline
 * does not solicit forever WITHIN one session. Cross-session persistence (the awaiting-history
 * registry) drives the longer-horizon retries on each reconnect.
 */
const RETRY_DELAYS_MS = [30_000, 90_000, 180_000];

/**
 * Delay (ms) before the FIRST solicitation. An external-commit self-join lands us one epoch ahead
 * of a peer that has not yet applied our commit: a bundle it re-encrypts at its old epoch would be
 * undecryptable to us and wasted. Waiting a beat lets the peer process our fan-out commit first, so
 * the very first bundle is encrypted at an epoch we can actually read.
 */
const INITIAL_SOLICIT_DELAY_MS = 2500;

type PendingSolicit = { timers: ReturnType<typeof setTimeout>[] };

/** In-memory registry of in-flight history solicitations, keyed by groupId. */
const pending = new Map<string, PendingSolicit>();

/**
 * Solicits the pre-join history bundle from one online member after this device freshly joined
 * `groupId` (via an external commit OR a Welcome). Both join paths land the device at the current
 * epoch WITHOUT the pre-join history it cannot decrypt on its own, so it must ask a member to
 * re-encrypt and resend it.
 *
 * Best-effort with bounded, receipt-driven retries. The delivery service picks a single online
 * responder per call, so re-sending on a backoff rotates past a peer that holds its WebSocket while
 * backgrounded (frozen-online: `redis.exists` is true but the app cannot process the frame) and
 * cannot answer. Retries stop as soon as a `history_bundle` actually arrives
 * (`noteHistoryBundleReceived`). The bundle receiver deduplicates by message id, so a redundant
 * resend is harmless.
 *
 * Durable across sessions: the group is recorded in the awaiting-history registry until a bundle
 * arrives, so the connection sync re-solicits it on every (re)connect (see
 * {@link reSolicitAwaitingHistory}). This fixes the old one-shot behaviour where a peer that stayed
 * offline for the ~3 min in-session window left the history never re-requested (a later session
 * finds the group already in WASM and recovery no longer solicits).
 */
export function solicitHistory(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  userId: string,
  groupId: string,
  log: (msg: string) => void,
  delaysMs: number[] = RETRY_DELAYS_MS,
  initialDelayMs: number = INITIAL_SOLICIT_DELAY_MS
): void {
  // Persist the intent so the history is re-solicited on future connections until it lands.
  markAwaitingHistory(userId, groupId);
  // Restart cleanly if a prior solicitation for this group is still in flight.
  cancelHistorySolicit(groupId);
  const entry: PendingSolicit = { timers: [] };
  pending.set(groupId, entry);

  const fire = (attempt: number): Promise<void> =>
    mlsService
      .sendHistoryRequest(groupId)
      .then(() => log(`[HISTORY_REQ] solicit attempt ${attempt} for ${groupId.slice(0, 8)}...`))
      .catch(() => {});

  // Attempt 0 is deferred by initialDelayMs so a self-join peer can apply our commit first.
  entry.timers.push(setTimeout(() => void fire(0), initialDelayMs));
  delaysMs.forEach((delay, i) => {
    const timer = setTimeout(() => void fire(i + 1), initialDelayMs + delay);
    entry.timers.push(timer);
  });
}

/**
 * Re-solicits the history bundle for every group still awaiting it (durable registry) that is
 * currently held locally. Called on each (re)connect: it is the cross-session retry seam that
 * survives the ~3 min in-session backoff. Groups NOT in local WASM are skipped here - they are
 * re-joined by the recovery seam, which solicits history itself on a successful join. Groups whose
 * in-session solicitation is still in flight are skipped to avoid restarting the backoff.
 */
export function reSolicitAwaitingHistory(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  userId: string,
  localGroupIds: Iterable<string>,
  log: (msg: string) => void
): void {
  const local = localGroupIds instanceof Set ? localGroupIds : new Set(localGroupIds);
  for (const groupId of enumerateAwaitingHistory(userId)) {
    if (!local.has(groupId) || pending.has(groupId)) continue;
    log(
      `[HISTORY_REQ] re-soliciting bundle for ${groupId.slice(0, 8)}... (awaiting across sessions)`
    );
    solicitHistory(mlsService, userId, groupId, log);
  }
}

/** Cancels any pending retries for `groupId` (bundle arrived, or a fresh solicitation supersedes). */
export function cancelHistorySolicit(groupId: string): void {
  const entry = pending.get(groupId);
  if (!entry) return;
  for (const timer of entry.timers) clearTimeout(timer);
  pending.delete(groupId);
}

/**
 * Signals that a history_bundle was received for `groupId`, so we stop soliciting it (this session
 * and future ones): cancels in-flight retries and clears the durable awaiting-history marker.
 */
export function noteHistoryBundleReceived(userId: string, groupId: string): void {
  cancelHistorySolicit(groupId);
  clearAwaitingHistory(userId, groupId);
}

/** Cancels every pending solicitation (session teardown / test cleanup). */
export function cancelAllHistorySolicit(): void {
  for (const groupId of pending.keys()) cancelHistorySolicit(groupId);
}
