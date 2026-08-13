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
 * small frame, one conversation row, and - on a cache hit - no read of the messages at all, so a
 * device may simply ask on every connection and believe the answer. Nothing has to be remembered
 * between sessions, so nothing has to be discharged.
 *
 * "Not expensive" is a claim about the FAN-OUT as much as about this device, and it was measured
 * rather than assumed: the probe is an MLS group broadcast, so the server used to write a queued row
 * and fire a silent push per member device - waking devices that the election can never pick,
 * because it only ever picks one that is online. A transport frame is now delivered to the online
 * members and to nobody else (`messaging.service.ts`, `postApplicationMessage`).
 *
 * IT WAS ONLY EVER A CLAIM ABOUT FRAMES, and the second measurement is the one that matters here: a
 * pass is cheap in traffic and was expensive in TIME. Nine groups took 4.35 s on a device, ~480 ms
 * each, and that cost is the election round trip - HTTP, holding no MLS lock, and serialised for a
 * reason that only ever applied to the sends it precedes. See {@link reconcileAllGroups}. The lesson
 * generalises past this file: "one small frame" bounds the bytes and says nothing about the latency
 * of asking permission to send it.
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

  // THE WINDOW IS RESERVED BEFORE THE FIRST AWAIT, and released again on every path that does not
  // end in a probe. It used to be written after the election instead, which was safe only because
  // the passes were strictly sequential - two of them can now overlap (a connection edge and a peer
  // coming back), and both would then read `recentlyAsked` as false for the same group and probe it
  // twice. Reserving here is what makes the coalescing window mean what it claims under concurrency;
  // the releases below keep "the next edge re-asks" exactly as true as it was.
  asked.set(groupId, now + PROBE_COALESCE_MS);

  // ASK THE SERVER FIRST. It elects the responder and answers `no_peer_online` immediately when
  // there is none, so electing first is what keeps the probe conditional: a state key sent before
  // the election is an MLS frame every member decrypts, for an exchange that was never started.
  let outcome;
  try {
    outcome = await mlsService.sendHistoryRequest(groupId);
  } catch (e) {
    // A THROW MEANS IT NEVER LEFT THE DEVICE - offline, DNS, TLS, a 502 from the proxy, an abort.
    // None of them is an answer about anybody else, so nothing is recorded about the peers.
    asked.delete(groupId);
    log(
      `[HISTORY_RECONCILE] could not reach the service for ${short}…: ${String(e).slice(0, 120)}`
    );
    return false;
  }

  if (outcome?.noPeerOnline) {
    // The server elects the responder, so it already knows there was none. Remembered only so the
    // peer-online edge can pick it up - it is not evidence that anything is missing.
    asked.delete(groupId);
    awaitingResponder.add(groupId);
    log(`[HISTORY_RECONCILE] no member online for ${short}… - will ask when one returns`);
    return false;
  }

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
 * How many groups may have an election in flight at once.
 *
 * A LIMIT RATHER THAN `Promise.all`, because the number of groups is not bounded by anything the
 * user controls: a device in fifty conversations would otherwise open fifty simultaneous requests on
 * a phone radio at the exact moment it reconnects, which is the shape of a self-inflicted thundering
 * herd. Six collapses the round-trip chain almost entirely - the pass is then bounded by the slowest
 * election rather than by their sum - while keeping the burst the size of a normal page load.
 */
const ELECTION_CONCURRENCY = 6;

/**
 * Reconciles every group this device holds locally. The connection path: run it once the mailbox
 * has drained, never before - a comparison made mid-drain reports a difference the device is in the
 * middle of closing by itself.
 *
 * CONCURRENT, WITH A BOUND - and the reason it is no longer sequential is a measurement rather than
 * a preference. This pass used to await each group in turn, justified by the encryption mutex: every
 * probe is an MLS send, and firing them all at once puts them through the same lock anyway. True of
 * the SENDS, and false of what the pass actually spends its time on. Measured on a device
 * (2026-08-13, nine groups):
 *
 *     10:37:13.136  asked 66e1b07e…      ← consecutive asks ~480 ms apart
 *     10:37:13.563  asked 4f87267a…
 *        ...
 *     10:37:17.482  reconciliation pass complete - 9 group(s) asked      = 4.35 s
 *
 * Each `[HISTORY_STATE] Sent` is logged in the same second as the `asked` that follows it, so the
 * encryption and the send are not where the time goes: the ~480 ms sits in `sendHistoryRequest`, the
 * HTTP election round trip - which takes no mutex at all and had no reason to be serialised. Nine of
 * them end to end were 4 s of a reconnect during which the inbound drain, whatever its size,
 * interleaved with them and inherited their duration. That is where the "Synchronisation des
 * messages…" banner's fixed four seconds came from.
 *
 * The MLS sends still serialise, on the mutex, exactly as they did - that part of the old comment
 * was right and nothing here changes it.
 */
export async function reconcileAllGroups(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  groupIds: Iterable<string>,
  log: (msg: string) => void
): Promise<void> {
  // A SNAPSHOT the workers shift from, so each group is taken exactly once: `shift` runs to
  // completion between awaits, which is what makes the hand-out safe without a lock.
  const queue = [...groupIds];
  const total = queue.length;
  let asks = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const groupId = queue.shift();
      if (groupId === undefined) return;
      if (await reconcileGroup(mlsService, groupId, log)) asks++;
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(ELECTION_CONCURRENCY, total) }, () => worker()));
  log(
    `[HISTORY_RECONCILE] reconciliation pass complete - ${asks}/${total} group(s) asked in ${Date.now() - started} ms`
  );
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
