import type { IMlsService } from '$lib/mls-client/IMlsService';

/**
 * When a device asks whether it holds the same history as its peers, and how it stops asking.
 *
 * This replaces the awaiting-history registry and everything built on top of it - the durable
 * marker, the reason ranks, the vouching, the 30-day give-up horizon, the 15-minute sweep, the
 * response-window store and the "history pending" banner. All of that existed to answer one
 * question: *asking is expensive, so what evidence justifies an ask, and what discharges it?* It
 * could not be answered, because the evidence was durable and its discharge condition was
 * unreachable - measured in production, both devices of a two-device DM carried a marker for 1.9
 * days, neither able to vouch for the other.
 *
 * **The question is gone rather than answered: asking is no longer expensive.** A state key is one
 * small frame and, on a cache hit, no store read at all, so a device may simply ask on every
 * connection and believe the answer. Nothing has to be remembered between sessions, so nothing has
 * to be discharged.
 *
 * What is left here is small on purpose:
 *
 * - **the triggers**, which are all state EDGES - a connection, a fresh join, a frame that could not
 *   be decrypted, a peer coming back online. The next edge IS the retry, so there is no retry;
 * - **a coalescing window**, so a replay that fails on forty frames of one group asks once;
 * - **the set of groups nobody was online to answer**, which is in memory and answers exactly that
 *   question - never "is this conversation broken", the conflation that produced the old marker.
 *
 * @see docs/wiki/protocols/history-reconciliation.md
 */

/**
 * How long a group is considered already-asked after a probe goes out.
 *
 * **It schedules nothing and it is not a retry.** Its only job is to collapse a burst of identical
 * triggers into one ask - a replay giving up on forty frames of the same conversation raises forty
 * edges for one difference. Being wrong about it costs at most one duplicated probe (harmless: the
 * responder answers a difference that is now empty) or one repair deferred to the next edge, and
 * the next connection re-asks unconditionally either way.
 */
const PROBE_COALESCE_MS = 30_000;

/** Groups whose probe went out recently, with the instant it stops counting as recent. */
const asked = new Map<string, number>();

/**
 * Groups whose last reconciliation could not run because the server elected nobody: every other
 * member was offline.
 *
 * In memory, and that is the whole design. It records "the last attempt found no responder" - which
 * is a fact about a moment, not about the conversation - and it is cleared the instant an attempt
 * actually goes out. The durable marker it replaces recorded "this conversation is missing history",
 * a claim about the conversation that nothing on this device was ever in a position to withdraw.
 */
const awaitingResponder = new Set<string>();

/**
 * Sends this device's state key for a group, resolving `true` when it went out.
 *
 * Registered by the session rather than threaded through every caller: reconciliation is triggered
 * from four places and only the session holds the store, the device key and the MLS client at once.
 */
export type HistoryProbeSender = (groupId: string) => Promise<boolean>;

let sendProbe: HistoryProbeSender | null = null;

/**
 * Installs the probe sender for this session, or clears it on teardown.
 *
 * Its absence is LOGGED at the point of use rather than passed over: a session that forgot to
 * register one would reconcile nothing at all, silently, and look exactly like a fleet with no peers
 * online.
 */
export function setHistoryProbeSender(fn: HistoryProbeSender | null): void {
  sendProbe = fn;
}

/** Whether a probe for `groupId` went out recently enough that another would be a duplicate. */
function recentlyAsked(groupId: string, now: number): boolean {
  const until = asked.get(groupId);
  if (until === undefined) return false;
  if (until > now) return true;
  asked.delete(groupId);
  return false;
}

/**
 * Asks the elected peer whether it holds the same history as this device for `groupId`.
 *
 * EXACTLY ONE ask goes out per coalescing window, and the answer is silence when the two agree - the
 * common case, and the reason this can run for every group on every connection. When they differ the
 * responder asks for a digest and the existing diff exchange takes over from there.
 *
 * @returns `true` when a probe left the device.
 */
export async function reconcileGroup(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  groupId: string,
  log: (msg: string) => void,
  now: number = Date.now()
): Promise<boolean> {
  const short = groupId.slice(0, 8);
  if (recentlyAsked(groupId, now)) return false;

  if (!sendProbe) {
    log(`[HISTORY_RECONCILE] no probe sender registered - ${short}… not reconciled`);
    return false;
  }

  // ASK THE SERVER FIRST. It elects the responder and answers `no_peer_online` immediately when
  // there is none, so electing first is what keeps the probe conditional: a state key sent before
  // the election is an MLS frame every member decrypts, for an exchange that was never started.
  let outcome;
  try {
    outcome = await mlsService.sendHistoryRequest(groupId);
  } catch (e) {
    // A THROW MEANS IT NEVER LEFT THE DEVICE - offline, DNS, TLS, a 502 from the proxy, an abort.
    // None of them is an answer about anybody else, so nothing is recorded about the peers.
    log(
      `[HISTORY_RECONCILE] could not reach the service for ${short}…: ${String(e).slice(0, 120)}`
    );
    return false;
  }

  if (outcome?.noPeerOnline) {
    // The server elects the responder, so it already knows there was none. Remembered only so the
    // peer-online edge can pick it up - it is not evidence that anything is missing.
    awaitingResponder.add(groupId);
    log(`[HISTORY_RECONCILE] no member online for ${short}… - will ask when one returns`);
    return false;
  }

  asked.set(groupId, now + PROBE_COALESCE_MS);
  awaitingResponder.delete(groupId);
  const sent = await sendProbe(groupId).catch((e) => {
    log(`[HISTORY_RECONCILE] probe failed for ${short}…: ${String(e).slice(0, 120)}`);
    return false;
  });
  if (!sent) {
    // The election went out but the probe did not, so the responder is waiting for something that
    // will never arrive. Let the next edge ask again rather than leaving the group coalesced out.
    asked.delete(groupId);
    return false;
  }
  log(`[HISTORY_RECONCILE] asked ${short}… whether we hold the same history`);
  return true;
}

/**
 * Reconciles every group this device holds locally. The connection path: run it once the mailbox
 * has drained, never before - a comparison made mid-drain reports a difference the device is in the
 * middle of closing by itself.
 *
 * Sequential rather than concurrent: each ask is one small frame, and firing seventeen MLS sends at
 * once puts them all through the same encryption mutex anyway.
 */
export async function reconcileAllGroups(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  groupIds: Iterable<string>,
  log: (msg: string) => void
): Promise<void> {
  let asks = 0;
  for (const groupId of groupIds) {
    if (await reconcileGroup(mlsService, groupId, log)) asks++;
  }
  log(`[HISTORY_RECONCILE] reconciliation pass complete - ${asks} group(s) asked`);
}

/**
 * Retries the groups whose last attempt found nobody online, because somebody just came back.
 *
 * Deliberately NOT every group: a presence edge is frequent and says nothing about the groups that
 * were already reconciled on this connection. Only the ones that could not be asked at all have
 * anything to gain.
 */
export async function reconcileGroupsAwaitingResponder(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  localGroupIds: Iterable<string>,
  log: (msg: string) => void
): Promise<void> {
  if (awaitingResponder.size === 0) return;
  const local = localGroupIds instanceof Set ? localGroupIds : new Set(localGroupIds);
  // A SNAPSHOT, not the live set: `reconcileGroup` writes back into `awaitingResponder` whenever the
  // election again finds nobody, and iterating the set itself would then re-visit what this pass has
  // just re-added.
  for (const groupId of Array.from(awaitingResponder)) {
    if (!local.has(groupId)) {
      // The group is gone from this device - nothing to reconcile it against.
      awaitingResponder.delete(groupId);
      continue;
    }
    await reconcileGroup(mlsService, groupId, log);
  }
}

/** Groups whose last reconciliation found no member online. Exposed for tests and diagnostics. */
export function groupsAwaitingResponder(): string[] {
  return [...awaitingResponder];
}

/**
 * Forgets everything held about a conversation, because the CONVERSATION is gone - deleted here,
 * deleted by a peer, or purged as an orphan.
 *
 * One seam rather than a line in each deletion path, for the reason the old registry learnt the hard
 * way: state describing a conversation may not outlive one, and three separate pieces of it once
 * did, one of them user-visible.
 */
export function forgetGroupReconciliation(groupId: string): void {
  asked.delete(groupId);
  awaitingResponder.delete(groupId);
}

/** Drops everything (session teardown, logout, test cleanup). */
export function resetHistoryReconciliation(): void {
  asked.clear();
  awaitingResponder.clear();
}
