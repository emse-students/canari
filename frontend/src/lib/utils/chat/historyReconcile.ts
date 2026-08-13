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
 * - **the set of groups whose ask could not even be attempted**, with what blocked it - nobody
 *   online, or no probe sender installed yet. In memory, and it answers exactly that question -
 *   never "is this conversation broken", the conflation that produced the old marker. It exists
 *   because those two triggers arrive with their evidence already spent: the frame that raised them
 *   is acked and gone, so an ask dropped here is a repair nothing will ever ask for again.
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
 * Why a reconciliation could not even be ATTEMPTED - which is also the name of the edge that would
 * let it be attempted.
 *
 * Both are facts about a MOMENT rather than about the conversation, and that distinction is the
 * whole design: the durable marker these replace recorded "this conversation is missing history", a
 * claim nothing on this device was ever in a position to withdraw.
 */
type DeferredReason =
  /** The server elected nobody - every other member was offline. Lifted when a peer comes back. */
  | 'no-peer-online'
  /**
   * No probe sender was installed yet, so there was nothing to ask WITH.
   *
   * **This is the one that lost a conversation for good.** The session installs the sender in
   * `sessionAuth` (it is the only place holding the store, the device key and the MLS client at
   * once), and inbound frames are already draining by then. A frame MLS can never decrypt asks for
   * the one repair that exists and is ACKed in the same breath - correctly, since no redelivery can
   * ever make it decrypt - so dropping the ask here destroyed the request and the evidence together,
   * and no later edge could raise it again. Measured on a production DM: permanently unreadable
   * frames at epoch 6, `no probe sender registered` on every boot, and the group never healed.
   *
   * It used to be masked: the connection swept every group unconditionally, so the next connection
   * re-asked by accident. Making the sweep conditional (see {@link connectionSweepDecision}) removed
   * the accident and left the drop, which is what turned a hidden fault into a permanent one.
   */
  | 'no-probe-sender';

/** Groups whose reconciliation could not be attempted, with what is blocking it. */
const deferred = new Map<string, DeferredReason>();

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
 *
 * **Installing one is an EDGE, and the caller must discharge it**: every group deferred as
 * `no-probe-sender` became askable at this instant, and nothing else will raise those triggers
 * again - the frames that raised them are acked and gone. Call
 * {@link retryDeferredReconciliations} straight after, in the same tick, so no frame drained in
 * between falls in the gap.
 */
export function setHistoryProbeSender(fn: HistoryProbeSender | null): void {
  sendProbe = fn;
}

// ── Whether a connection needs a sweep at all ────────────────────────────────────────────────────

/**
 * The server's message retention window, mirrored from `RETENTION_WINDOW_MS`
 * (`apps/chat-delivery-service/src/retention.constants.ts`).
 *
 * **THE TWO MUST MOVE TOGETHER, and this one may never be the larger.** It decides how long a device
 * may be away before it stops trusting the server's queue to have kept everything for it: shorter
 * than the server's window costs a sweep nobody needed, longer would skip the one sweep that was.
 */
const SERVER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const lastConnectedKey = (userId: string, deviceId: string) =>
  `history_last_connected:${userId}:${deviceId}`;

function readLastConnected(userId: string, deviceId: string): number | null {
  try {
    const raw = localStorage.getItem(lastConnectedKey(userId, deviceId));
    if (!raw) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    // Unreadable storage is not "connected recently" - fall through to sweeping, which is the
    // answer that cannot lose a message.
    return null;
  }
}

/**
 * Whether this connection should compare every group against its peers, and WHY.
 *
 * **The sweep used to be unconditional, and that was the whole cost.** Every connection asked every
 * local group - nine groups on a device meant nine probes out and their answers back, on a server
 * carrying no other traffic, and the receiving side counted those frames as arriving messages. The
 * mechanism announced itself as a backlog and, for two people talking, was pure noise.
 *
 * It is a HEAL, so it runs on evidence. Three things can leave a gap and only one of them needs a
 * sweep:
 *
 *  - a frame that arrived and could never be applied - already triggers `reconcileGroup` where it
 *    happens (`handleUnreadableFrame`, the replay's `sawUnreadableFrame`), against the one group
 *    that saw it;
 *  - a frame that never arrived - the server still holds it, unacknowledged, and redelivers it. A
 *    frame the client could not apply is deliberately NOT acked (`shouldAckAfterSuccess`), so the
 *    queue itself is the record, and no peer needs asking;
 *  - a frame the server no longer holds, because this device was away longer than it keeps things.
 *    Nothing local witnesses that, and it is the only case a sweep answers.
 *
 * So the question is exactly "could the server have dropped something for me", and the durable
 * answer is when this device last connected. **This is not a clock driving work**: nothing is
 * scheduled, nothing fires on an interval, and being wrong costs one sweep or one deferred repair,
 * never a lost message. An absent record means a new or restored store - which is also the case that
 * needs everything - so one value answers both.
 */
export function connectionSweepDecision(
  userId: string,
  deviceId: string,
  now: number = Date.now()
): { sweep: boolean; reason: string } {
  const last = readLastConnected(userId, deviceId);
  if (last === null) {
    return { sweep: true, reason: 'no record of an earlier connection - new or restored store' };
  }

  const awayMs = now - last;
  if (awayMs < 0) {
    // The record is in the future: the device clock moved backwards, so the age is unusable. Sweep,
    // for the same reason unreadable storage sweeps.
    return { sweep: true, reason: 'last-connected timestamp is in the future - clock moved back' };
  }

  const awayDays = Math.floor(awayMs / 86_400_000);
  if (awayMs >= SERVER_RETENTION_MS) {
    return { sweep: true, reason: `away ${awayDays} d, past what the server keeps` };
  }
  return { sweep: false, reason: `away ${awayDays} d, inside what the server keeps` };
}

/**
 * Records that this device is connected NOW, which is what the next connection reasons about.
 *
 * Written on every connection whether or not it swept: the question is how long the device was
 * away, not when it last repaired itself.
 */
export function noteConnection(userId: string, deviceId: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(lastConnectedKey(userId, deviceId), String(now));
  } catch {
    // A device that cannot write this sweeps on every connection - the old behaviour, and the safe
    // one. Logged by the caller, which holds the session's log.
  }
}

/** Test seam: forgets this device's connection record so a case starts from a known state. */
export function resetConnectionRecord(userId: string, deviceId: string): void {
  try {
    localStorage.removeItem(lastConnectedKey(userId, deviceId));
  } catch {
    /* nothing to forget */
  }
}

// ── The one-shot audit, for damage that predates the mechanism that would have caught it ─────────

/**
 * Which round of the one-shot audit this build asks for. **Bumping it re-runs the audit on every
 * device in the fleet, once**, and that is the only way to run it again.
 *
 * WHY AN AUDIT EXISTS AT ALL. Every other trigger needs a live witness: an unreadable frame, a
 * replay that gave up, a device away past what the server keeps. A conversation damaged BEFORE the
 * repair path worked has none of them left - the frame that would have raised it was acked and
 * deleted at the time, so the local store holds an ABSENCE, and an absence is not detectable from
 * one side. Measured on a production DM (2026-08-13): a clean boot with three devices online raised
 * one line, `no sweep`, and nothing asked, because nothing was left to ask.
 *
 * So the audit is not a repair and not a schedule - it is a one-time reason to COMPARE, on devices
 * that have no reason of their own. Generation 1 is the amnesty for everything that predates the
 * deferred-ask fix.
 */
const HISTORY_AUDIT_GENERATION = 1;

const auditKey = (userId: string, deviceId: string) => `history_audit:${userId}:${deviceId}`;

/** What a device remembers of the audit: which round it ran, and which groups it really asked. */
type AuditRecord = { generation: number; groupIds: string[] };

function readAuditRecord(userId: string, deviceId: string): AuditRecord | null {
  try {
    const raw = localStorage.getItem(auditKey(userId, deviceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuditRecord>;
    // A record from an EARLIER generation is not a weaker record, it is a record of a different
    // question - discarding it is what makes a bump mean "ask everyone again".
    if (parsed?.generation !== HISTORY_AUDIT_GENERATION) return null;
    return {
      generation: parsed.generation,
      groupIds: Array.isArray(parsed.groupIds) ? parsed.groupIds : [],
    };
  } catch {
    // Unreadable or malformed storage owes the audit, for the same reason unreadable storage sweeps:
    // it is the answer that cannot leave a conversation unrepaired.
    return null;
  }
}

/**
 * The groups that still owe this generation's audit.
 *
 * PER GROUP, AND THAT IS THE WHOLE DESIGN. Recording the audit against the DEVICE would discharge
 * it on a pass during which some group was never actually compared - every member offline, so the
 * ask was deferred rather than sent - and that group would then never be audited again. Recording
 * only the groups an ask really left for means the ones that could not be asked come back on the
 * next connection, alone, instead of dragging the whole store with them.
 *
 * A group joined AFTER the audit ran is indistinguishable from one that was deferred, and costs
 * exactly one probe, once, ever. That is the price of not keeping a second durable record of when
 * each group was joined, and it is the cheaper of the two.
 */
export function groupsOwingAudit(
  userId: string,
  deviceId: string,
  localGroupIds: Iterable<string>
): string[] {
  const done = new Set(readAuditRecord(userId, deviceId)?.groupIds ?? []);
  return [...localGroupIds].filter((id) => !done.has(id));
}

/**
 * Records that these groups were really asked, and so no longer owe the audit.
 *
 * **Called only with the groups a probe actually LEFT for** - never with the pass's input list. The
 * two differ by exactly the deferred ones, and writing the input would be discharging a deferral on
 * a step that precedes the act, the mistake this module has already paid for once.
 */
export function noteGroupsAudited(
  userId: string,
  deviceId: string,
  groupIds: Iterable<string>
): void {
  const asked = [...groupIds];
  if (asked.length === 0) return;
  try {
    const done = new Set(readAuditRecord(userId, deviceId)?.groupIds ?? []);
    for (const id of asked) done.add(id);
    const record: AuditRecord = { generation: HISTORY_AUDIT_GENERATION, groupIds: [...done] };
    localStorage.setItem(auditKey(userId, deviceId), JSON.stringify(record));
  } catch {
    // A device that cannot write this re-audits on every connection - wasteful, never wrong, and it
    // is the same failure mode as an unwritable connection record. Logged by the caller.
  }
}

/** Test seam: forgets this device's audit record so a case starts from a known state. */
export function resetAuditRecord(userId: string, deviceId: string): void {
  try {
    localStorage.removeItem(auditKey(userId, deviceId));
  } catch {
    /* nothing to forget */
  }
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
    // DEFERRED, NOT DROPPED. The caller that raised this trigger has usually just acked the frame
    // that raised it, so this ask is the only remaining trace of the gap - see `no-probe-sender`.
    deferred.set(groupId, 'no-probe-sender');
    log(`[HISTORY_RECONCILE] no probe sender yet - ${short}… deferred until one is installed`);
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
    deferred.set(groupId, 'no-peer-online');
    log(`[HISTORY_RECONCILE] no member online for ${short}… - will ask when one returns`);
    return false;
  }

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
  // CLEARED ONLY ONCE AN ASK ACTUALLY LEFT THE DEVICE. Clearing it on the election - which is where
  // it used to sit - discharged the deferral on the strength of a round trip that asks nobody
  // anything, so a group whose probe then failed to encrypt was recorded as attended to.
  deferred.delete(groupId);
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
): Promise<string[]> {
  // A SNAPSHOT the workers shift from, so each group is taken exactly once: `shift` runs to
  // completion between awaits, which is what makes the hand-out safe without a lock.
  const queue = [...groupIds];
  const total = queue.length;
  // THE GROUPS AN ASK ACTUALLY LEFT FOR, not the ones the pass was handed. The audit discharges
  // against this list, so the difference between the two - the deferred groups - is exactly what
  // comes back on the next connection.
  const askedGroups: string[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const groupId = queue.shift();
      if (groupId === undefined) return;
      if (await reconcileGroup(mlsService, groupId, log)) askedGroups.push(groupId);
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(ELECTION_CONCURRENCY, total) }, () => worker()));
  log(
    `[HISTORY_RECONCILE] reconciliation pass complete - ${askedGroups.length}/${total} group(s) asked in ${Date.now() - started} ms`
  );
  return askedGroups;
}

/**
 * Retries every group whose reconciliation could not be attempted, because one of the two things
 * blocking it just arrived: a peer came back online, or this session installed its probe sender.
 *
 * ONE PASS FOR BOTH REASONS RATHER THAN ONE EACH. The reason is recorded to explain the group, not
 * to route it: retrying a group whose blocker is still in place costs one election that answers
 * `noPeerOnline` again, or one line saying there is still no sender - and re-deferring is exactly
 * what should happen then. Splitting it would mean a group could be deferred under one reason and
 * discharged only by the other's edge, which is how the `no-probe-sender` gap stayed open.
 *
 * Deliberately NOT every group: these edges are frequent and say nothing about the groups that were
 * already compared. Only the ones that could not be asked at all have anything to gain.
 */
export async function retryDeferredReconciliations(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  localGroupIds: Iterable<string>,
  log: (msg: string) => void
): Promise<void> {
  if (deferred.size === 0) return;
  const local = localGroupIds instanceof Set ? localGroupIds : new Set(localGroupIds);
  // A SNAPSHOT, not the live map: `reconcileGroup` writes back into `deferred` whenever the blocker
  // is still there, and iterating the map itself would then re-visit what this pass just re-added.
  for (const groupId of Array.from(deferred.keys())) {
    if (!local.has(groupId)) {
      // The group is gone from this device - nothing to reconcile it against.
      deferred.delete(groupId);
      continue;
    }
    await reconcileGroup(mlsService, groupId, log);
  }
}

/** Groups whose reconciliation could not be attempted, and why. Exposed for tests and diagnostics. */
export function deferredReconciliations(): Array<[string, DeferredReason]> {
  return [...deferred];
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
  deferred.delete(groupId);
}

/** Drops everything (session teardown, logout, test cleanup). */
export function resetHistoryReconciliation(): void {
  asked.clear();
  deferred.clear();
}
