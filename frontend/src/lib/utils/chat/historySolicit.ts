import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { IStorage } from '$lib/db';
import { historyRequestPendingStore } from '$lib/stores/historyRequestPending.svelte';
import {
  markAwaitingHistory,
  clearAwaitingHistory,
  enumerateAwaitingHistory,
  isAwaitingHistory,
} from './awaitingHistoryRegistry';

/**
 * Bounded backoff (ms) for re-soliciting a history bundle after a fresh join. Kept short enough to
 * ride out a peer that is briefly away, bounded so a group whose only other member stays offline
 * does not solicit forever WITHIN one session. Cross-session persistence (the awaiting-history
 * registry) drives the longer-horizon retries on each reconnect.
 *
 * WP-HIST-1 (Option C): the in-session burst now works together with a request-level timeout/
 * retry tracker (`historyRequestPendingStore`). The tracker is what lets the UI show a
 * `pending-offline` state when no bundle arrived inside the response window.
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
 * Broadcasts this device's digest for a group, resolving `true` when it went out.
 *
 * Registered by the session rather than threaded through every caller: soliciting is triggered from
 * four places (a Welcome, an external join, each reconnect, a give-up escalation), and only the
 * session holds the store, the device key and the MLS client at once. Passing all three down four
 * call chains to reach one broadcast would put storage knowledge in every one of them.
 */
export type HistoryDigestBroadcaster = (groupId: string) => Promise<boolean>;

let broadcastDigest: HistoryDigestBroadcaster | null = null;

/**
 * Installs the digest broadcaster for this session, or clears it on teardown.
 *
 * While none is installed every solicitation degrades to asking for the peer's whole store - correct,
 * just wasteful - so its absence is LOGGED at the point of use rather than passed over: a session
 * that silently forgot to register one would look exactly like a fleet of peers too old to answer.
 */
export function setHistoryDigestBroadcaster(fn: HistoryDigestBroadcaster | null): void {
  broadcastDigest = fn;
}

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
 * Durable across sessions ONLY through the awaiting-history registry, which this function no
 * longer writes: soliciting is the ACTION, deciding that history is missing is a separate
 * judgement that needs evidence (see {@link solicitHistoryIfMissing}). Once a marker exists the
 * connection sync re-solicits it on every (re)connect (see {@link reSolicitAwaitingHistory}),
 * which is what covers a peer that stayed offline for the whole ~3 min in-session window.
 */
export function solicitHistory(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  groupId: string,
  log: (msg: string) => void,
  delaysMs: number[] = RETRY_DELAYS_MS,
  initialDelayMs: number = INITIAL_SOLICIT_DELAY_MS
): void {
  // Restart cleanly if a prior solicitation for this group is still in flight.
  cancelHistorySolicit(groupId);
  const entry: PendingSolicit = { timers: [] };
  pending.set(groupId, entry);

  const fire = async (attempt: number): Promise<void> => {
    // WP-HIST-1: register the start of this attempt with the timeout/retry tracker.
    historyRequestPendingStore.start(groupId, () => void fire(attempt + 1));

    // Say what we HOLD before asking, so the elected member can answer with the difference. Sent
    // first and awaited: it rides inside MLS while the request goes over the WebSocket, and the
    // responder only waits a few seconds for it before falling back to its whole store. Failing to
    // describe ourselves is not a reason to skip the ask - the fallback is exactly the old
    // behaviour, which is also what a peer running an older build will do anyway.
    if (broadcastDigest) {
      await broadcastDigest(groupId).catch((e) =>
        log(
          `[HISTORY_REQ] digest broadcast failed for ${groupId.slice(0, 8)}...: ${String(e).slice(0, 120)}`
        )
      );
    } else {
      log(
        `[HISTORY_REQ] no digest broadcaster registered - asking ${groupId.slice(0, 8)}... for its whole store`
      );
    }

    return mlsService
      .sendHistoryRequest(groupId)
      .then(() => log(`[HISTORY_REQ] solicit attempt ${attempt} for ${groupId.slice(0, 8)}...`))
      .catch((e) => {
        // Network-level failure (offline, fetch abort, etc.): move straight to pending-offline.
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          log(`[HISTORY_REQ] offline during attempt ${attempt} for ${groupId.slice(0, 8)}...`);
          historyRequestPendingStore.markOffline(groupId);
          return;
        }
        log(
          `[HISTORY_REQ] attempt ${attempt} failed for ${groupId.slice(0, 8)}...: ${String(e).slice(0, 120)}`
        );
      });
  };

  // Attempt 0 is deferred by initialDelayMs so a self-join peer can apply our commit first.
  entry.timers.push(setTimeout(() => void fire(0), initialDelayMs));
  delaysMs.forEach((delay, i) => {
    const timer = setTimeout(() => void fire(i + 1), initialDelayMs + delay);
    entry.timers.push(timer);
  });
}

/**
 * Solicits the history bundle for a group this device has just (re)joined, but ONLY when it can
 * point at something missing. This is the single decision seam for "do I need history?", and it
 * exists because the join event alone is not evidence: the commonest join of all is a device
 * rotating its MLS identity inside a browser whose message store - keyed by USER, not by device -
 * still holds every message. Asking on the join event marked every group of such a device, forever.
 *
 * Two things count as evidence, in order:
 *  1. An existing awaiting marker, which the replay writes when it gives up on a frame it can never
 *     decrypt. That is a PROVEN gap, whatever the store holds.
 *  2. An empty local store for the group: we hold nothing, so we cannot tell a conversation that is
 *     empty from one whose history we are missing, and only a peer can. This is also the sole case
 *     covering a group whose server-side stream has been trimmed - a gap no replay can ever observe,
 *     because a frame that is gone never fails to decrypt.
 *
 * A non-empty store with nothing unreadable in it means we are not missing anything: we stay quiet
 * and drop any marker left behind by the old join-time behaviour.
 *
 * A storage READ that failed proves nothing either way, so it falls through to soliciting: a
 * needless bundle is deduplicated by id on arrival, a skipped one is lost.
 */
export async function solicitHistoryIfMissing(params: {
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
  groupId: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { mlsService, storage, userId, deviceKeyB64, groupId, log } = params;
  const short = groupId.slice(0, 8);

  if (!isAwaitingHistory(userId, groupId)) {
    let localCount: number | null = null;
    try {
      localCount = ((await storage?.getMessages(groupId, deviceKeyB64)) ?? []).length;
    } catch (e) {
      log(`[HISTORY_REQ] store read failed for ${short}...: ${String(e).slice(0, 120)}`);
    }
    if (localCount !== null && localCount > 0) {
      // Nothing unreadable, and we already hold this conversation: there is nothing to ask for.
      clearAwaitingHistory(userId, groupId);
      log(`[HISTORY_REQ] ${short}... already holds ${localCount} message(s) - no bundle needed`);
      return;
    }
    markAwaitingHistory(userId, groupId, 'no-local-history');
  }

  solicitHistory(mlsService, groupId, log);
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
    solicitHistory(mlsService, groupId, log);
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
  // WP-HIST-1: clear the reactive pending state so the UI stops showing the offline banner.
  historyRequestPendingStore.noteReceived(groupId);
}

/** Cancels every pending solicitation (session teardown / test cleanup). */
export function cancelAllHistorySolicit(): void {
  for (const groupId of pending.keys()) cancelHistorySolicit(groupId);
}
