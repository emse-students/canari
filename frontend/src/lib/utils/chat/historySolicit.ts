import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { IStorage } from '$lib/db';
import { historyRequestPendingStore } from '$lib/stores/historyRequestPending.svelte';
import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
import {
  markAwaitingHistory,
  clearAwaitingHistory,
  enumerateAwaitingHistory,
  isAwaitingHistory,
  isProvenAwaitingReason,
  readAwaitingHistoryReason,
} from './awaitingHistoryRegistry';

/**
 * Delay (ms) between deciding to solicit and actually sending.
 *
 * The ONE delay in this module, and it is an ordering constraint rather than a retry knob: an
 * external-commit self-join lands us one epoch ahead of a peer that has not yet applied our commit,
 * and a bundle that peer re-encrypts at its old epoch is undecryptable to us and wasted. Waiting a
 * beat lets the fan-out commit be processed first.
 *
 * It compensates for an epoch ordering this module cannot observe. Anything that made it observable
 * would replace it outright - it is not tuned, and it must never be repurposed as a backoff.
 */
const INITIAL_SOLICIT_DELAY_MS = 2500;

/**
 * How often the session sweeps its awaiting groups (ms).
 *
 * Every other trigger is an EVENT - a fresh join, a reconnect, a peer coming back online, a newly
 * detected unreadable frame - and none is guaranteed to happen again in a tab left open for a day.
 * This is the floor under all of them, deliberately slow: a group still carrying a marker has
 * already failed the fast paths, and the exchange it starts is a diff that costs nothing when there
 * is no difference.
 */
export const AWAITING_SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * Groups whose solicitation has been decided but not yet sent, i.e. inside
 * {@link INITIAL_SOLICIT_DELAY_MS}. Once it is sent, the response window in
 * `historyRequestPendingStore` is what says an attempt is outstanding - see
 * {@link isSolicitInFlight}.
 */
const scheduled = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Whether an attempt for `groupId` is outstanding, i.e. whether soliciting again would duplicate one.
 *
 * There is no burst any more, so there is no schedule to reason about and no end-of-burst to compute:
 * an attempt is outstanding exactly while it is waiting to be sent, or waiting to be answered. Both
 * are STATES ended by an event, never durations compared against a clock. That distinction is the
 * whole point - the previous version derived the answer from a `burstEndsAt` arithmetic, and a stale
 * entry it never cleared silenced every later trigger for the life of the tab.
 *
 * A group is therefore re-solicitable the instant its response window closes, and what decides
 * whether it IS re-solicited is the durable marker, not this function.
 */
export function isSolicitInFlight(groupId: string): boolean {
  return scheduled.has(groupId) || historyRequestPendingStore.getPhase(groupId) === 'pending';
}

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
 * EXACTLY ONE request goes out per call, and calling again while one is outstanding does nothing.
 * There is no backoff ladder here any more, and removing it is the point rather than a
 * simplification: two independent ladders (this one and the tracker's) drove the same request, so
 * the traffic a single group could generate was their product and no single place could be read to
 * predict it.
 *
 * What makes the repair reliable instead is that it CONVERGES rather than repeats. Each exchange is
 * a diff, so it strictly reduces the difference between the two stores and costs nothing at all when
 * there is none; and the decision to run one is taken from durable EVIDENCE (the awaiting-history
 * marker), never from a timer. So the mechanism re-runs on state edges - a reconnect, a peer coming
 * back online, a newly detected unreadable frame, the slow sweep - and terminates on a proof: a peer
 * that compared its whole store and found us complete.
 *
 * The one timer left is the tracker's response window, and its only job is to decide that an attempt
 * is OVER, which nothing else can observe. It schedules no traffic of its own.
 *
 * The election picks a single online responder per request, so a group whose elected peer was
 * frozen-online (`redis.exists` true, app unable to process the frame) is covered by the NEXT edge
 * rotating onto a different member - not by asking the same one faster.
 */
export function solicitHistory(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  groupId: string,
  log: (msg: string) => void,
  initialDelayMs: number = INITIAL_SOLICIT_DELAY_MS
): void {
  if (isSolicitInFlight(groupId)) {
    log(`[HISTORY_REQ] ${groupId.slice(0, 8)}... already has an attempt outstanding - not asking`);
    return;
  }

  const fire = async (): Promise<void> => {
    scheduled.delete(groupId);
    // Opens the response window: from here "outstanding" means "waiting for an answer".
    historyRequestPendingStore.start(groupId);

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
      .then((outcome) => {
        if (outcome?.noPeerOnline) {
          // The server elects the responder, so it already knows there was none. Waiting out the
          // response window for an answer nobody was asked for tells the user nothing; the next
          // edge - a peer coming online, a reconnect, the sweep - is what asks again.
          log(`[HISTORY_REQ] no member online for ${groupId.slice(0, 8)}...`);
          historyRequestPendingStore.markOffline(groupId);
          return;
        }
        log(`[HISTORY_REQ] solicited ${groupId.slice(0, 8)}...`);
      })
      .catch((e) => {
        // Network-level failure (offline, fetch abort, etc.): move straight to pending-offline.
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          log(`[HISTORY_REQ] offline while soliciting ${groupId.slice(0, 8)}...`);
          historyRequestPendingStore.markOffline(groupId);
          return;
        }
        log(
          `[HISTORY_REQ] solicit failed for ${groupId.slice(0, 8)}...: ${String(e).slice(0, 120)}`
        );
      });
  };

  scheduled.set(
    groupId,
    setTimeout(() => void fire(), initialDelayMs)
  );
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
 * in-session solicitation is still in flight are skipped to avoid restarting the backoff - "in
 * flight" being a live burst, never merely a burst that once started (see
 * {@link isSolicitInFlight}).
 */
export function reSolicitAwaitingHistory(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  userId: string,
  localGroupIds: Iterable<string>,
  log: (msg: string) => void
): void {
  const local = localGroupIds instanceof Set ? localGroupIds : new Set(localGroupIds);
  for (const groupId of enumerateAwaitingHistory(userId)) {
    if (!local.has(groupId) || isSolicitInFlight(groupId)) continue;
    log(
      `[HISTORY_REQ] re-soliciting bundle for ${groupId.slice(0, 8)}... (awaiting across sessions)`
    );
    solicitHistory(mlsService, groupId, log);
  }
}

/**
 * Starts the session-long sweep that re-solicits every group still awaiting history, and returns its
 * stop function.
 *
 * Completeness is otherwise checked only on EVENTS - the join burst, each reconnect, a peer coming
 * back online, a give-up escalation - and none of them is guaranteed to happen again in a session
 * that stays open. This is the floor: slow on purpose (see {@link AWAITING_SWEEP_INTERVAL_MS}),
 * skipping groups whose burst is still live, and doing nothing at all when no marker exists.
 *
 * It pauses while the document is hidden, which is both a battery decision and a correctness one:
 * the sweep exists to run in the tab somebody is actually using, and coming back to the foreground
 * fires it immediately.
 */
export function startAwaitingHistorySweep(params: {
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>;
  userId: string;
  getLocalGroups: () => Iterable<string>;
  log: (msg: string) => void;
  intervalMs?: number;
}): () => void {
  const {
    mlsService,
    userId,
    getLocalGroups,
    log,
    intervalMs = AWAITING_SWEEP_INTERVAL_MS,
  } = params;
  return createPausableInterval(() => {
    reSolicitAwaitingHistory(mlsService, userId, getLocalGroups(), log);
  }, intervalMs);
}

/** Cancels a solicitation not yet sent (the bundle arrived first, or the group is being dropped). */
export function cancelHistorySolicit(groupId: string): void {
  const timer = scheduled.get(groupId);
  if (timer === undefined) return;
  clearTimeout(timer);
  scheduled.delete(groupId);
}

/**
 * Signals that a history_bundle was received for `groupId`.
 *
 * A bundle always proves one thing - somebody answered - so the offline banner comes down whatever
 * it contains. What it does NOT always prove is that the wait is over, and conflating the two is
 * how a partial answer used to end a solicitation for good (WP-HIST-3):
 *
 * - An EMPTY bundle is the only authoritative "you are missing nothing": both senders compare their
 *   whole store before sending one, and neither sends it while itself awaiting history. It ends the
 *   wait whatever the evidence behind it was.
 * - A NON-EMPTY bundle carries messages, and nothing more. It voids a PRESUMPTION - "I hold nothing
 *   for this group" stops being true the moment a message lands - but it cannot answer a PROOF: the
 *   peer that listed forty ids we lack is not repaid by a chunk of forty others, and a history big
 *   enough to be chunked arrives as several non-empty bundles anyway. So a proven marker survives,
 *   the in-session retries keep running, and the NEXT diff decides. That is what makes the marker
 *   empty itself: each exchange strictly reduces the difference, so it converges on the empty bundle
 *   above rather than on a bundle count.
 */
export function noteHistoryBundleReceived(
  userId: string,
  groupId: string,
  bundleMessageCount: number
): void {
  // WP-HIST-1: clear the reactive pending state so the UI stops showing the offline banner.
  historyRequestPendingStore.noteReceived(groupId);

  const reason = readAwaitingHistoryReason(userId, groupId);
  if (bundleMessageCount > 0 && reason !== null && isProvenAwaitingReason(reason)) {
    return;
  }

  cancelHistorySolicit(groupId);
  clearAwaitingHistory(userId, groupId);
}

/** Cancels every solicitation not yet sent (session teardown / test cleanup). */
export function cancelAllHistorySolicit(): void {
  // Deleting the current key mid-iteration is well defined for a Map, so no copy is needed.
  for (const groupId of scheduled.keys()) cancelHistorySolicit(groupId);
}
