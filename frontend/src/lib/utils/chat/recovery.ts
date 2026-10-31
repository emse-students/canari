import type {
  ExternalJoinOutcome,
  GroupMeta,
  IMlsService,
  UserGroupRow,
  DeviceMembershipRow,
  WelcomeRequestAnswer,
} from '$lib/mls-client/IMlsService';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import type { SvelteMap } from 'svelte/reactivity';
import { persistMlsStateAfterMutation, purgeLocalConversationRecord } from './groupActions';
import {
  classifyServerStatus,
  decideAbsentGroupFate,
  isDistributionGroupMeta,
  readStillUserMember,
} from './groupLifecycle';
import { markGroupNotReady, clearGroupNotReady, readNotReadySince } from './notReadyRegistry';
import { reconcileGroup } from './historyReconcile';
import { pendingGroupExitIds } from './pendingGroupExits';
import { ensureConversationForServerGroup } from './serverGroupConversation';
import { retireConversation } from './conversations';
import { dropGroupState } from './dropGroupState';
import { holdsGroupState } from './groupUsability';
import { readWelcomeOwedFromRow, type WelcomeOwedReading } from './welcomeOwed';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import { isNeverAdmitted } from './admissionState';
import { readGroupSweepSnapshot } from './groupSweep';

/**
 * Minimum interval between two recovery attempts for the same not-ready group (throttle + cadence).
 * `requestReAdd` is the single recovery ACTION seam; it self-throttles to one attempt per this
 * interval regardless of how often it is invoked. The SYNC_WATCHDOG (the sole cadence owner)
 * re-invokes it every poll, and reactive paths call it on demand - all funnel through this cooldown.
 * 60s gives FCM iOS (background) time to wake a peer for the welcome_request fallback.
 */
export const RECOVERY_TIMEOUT_MS = 60_000;

/**
 * A wait, in the coarsest unit that still reads: `42s`, `17m`, `3h`, `5d`.
 *
 * Coarse ON PURPOSE. This goes in a log line whose only job is to separate "this group is on its
 * first pass" from "this group has never been joined", and a millisecond count makes a reader do
 * the division. Nothing branches on it.
 */
function formatWaitedFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Per-group timestamp (ms) of the last recovery attempt by {@link requestReAdd}. requestReAdd owns
 * no timer (the SYNC_WATCHDOG owns the cadence); this cooldown is the single throttle that caps
 * every caller - watchdog cadence and reactive triggers alike - to one attempt per
 * {@link RECOVERY_TIMEOUT_MS} per group.
 */
const lastReAddAt = new Map<string, number>();

/**
 * Per-group record of a recovery that the SERVER has already proved cannot progress, keyed by the
 * pair of epochs that made it true: `${baseEpoch}/${activeEpoch}`.
 *
 * **THE QUESTION WAS ANSWERED, AND ASKING IT AGAIN IS NOT A RETRY.** A group whose published base
 * is behind its active epoch can only be repaired by a member holding the tree, and
 * `base-refresh-request` answers `no_peer_online` when the server looked at the roster and found
 * none. While both numbers stand still the same external join is refused by the same gate, so
 * re-running the pass costs four HTTP calls and learns nothing.
 *
 * **BUT THE SET IS THE SET OF MEMBERS WHO ARE ONLINE, AND A MEMBER CONNECTING CHANGES IT WITH
 * NEITHER NUMBER MOVING** - so the pair alone is a column read for a question it was not written to
 * answer, and the pass re-asks the election itself on its ordinary cadence while a record stands
 * ({@link reAskTheElection}). That is ONE HTTP call, not four: the memberships, the conversation row
 * and the join are all decided by the pair, and only the election is not.
 *
 * Two other things end it and neither may be relied on alone. `initializeConnection` republishes a
 * stale base for every group the returning device holds, which moves `baseEpoch` - but **that fact
 * is not this device's to guarantee**: it shipped on 2026-09-04, `minClientVersion` does not require
 * it, and a republish that fails is logged and nothing more. The peer-return edge discharges these
 * records too ({@link forgetProvenDeadEnds}) - but its watchlist is assembled by the chat UI and a
 * GROUP conversation puts nobody on it, which is precisely the shape measured below. Both are
 * faster than the re-ask when they fire, and neither is what makes this terminate.
 *
 * Measured on production 2026-09-12, and it is the whole reason this map exists: group `4f87267a`
 * was asked once a minute for at least twenty-seven consecutive minutes - four HTTP calls a pass -
 * and the server logged `NO_PEER_ONLINE members=1` to every one of them. Its only other member had
 * not connected since 2026-08-03. Three groups on that estate had been in this state since
 * 2026-08-29, 08-30 and 08-31 respectively: thirteen days, not a transient.
 *
 * **THE VALUE IS THE PROOF, WHICH IS WHY IT IS NOT A BOOLEAN.** A flag would have to be expired by
 * a clock, and this repository's rule is that termination comes from a proof and never from one.
 * The pair IS the state the verdict was taken against - the same two numbers `classifyBase` reads
 * for the holder's half of this problem - so the dead end ENDS the instant either moves, whoever
 * moved it and for whatever reason. A member committing moves `activeEpoch`; a member repairing on
 * its next connection moves `baseEpoch`; both are read on the one call every pass already makes.
 */
const noRepairerAt = new Map<string, string>();

/** Groups whose "own KeyPackage not published" refusal was already logged, by the reason logged. */
const ownKeyPackageLogged = new Map<string, string>();

/** The pair of epochs a dead end is proved against, or `undefined` when the server did not say. */
function epochPair(input: { baseEpoch?: number | null; activeEpoch?: number }): string | undefined {
  // A server too old to send them says nothing, and nothing is not a proof: without the pair there
  // is no way to notice the state changing, so no dead end may be recorded against it.
  if (typeof input.activeEpoch !== 'number') return undefined;
  if (typeof input.baseEpoch !== 'number') return undefined;
  return `${input.baseEpoch}/${input.activeEpoch}`;
}

/**
 * Clears the recovery cooldowns. Called at session setup so a re-login does not inherit a stale
 * throttle that would delay the first recovery attempt of the new session.
 *
 * The dead-end records go with them. They are proofs about the SERVER'S state and the pair is what
 * keeps them honest, so a new session does not strictly need a clean slate - but a session is the
 * one boundary at which this device's own view was rebuilt from nothing, and paying one extra pass
 * per locked-out group at login is cheaper than reasoning about what a stale entry would hide.
 */
export function resetReAddCooldowns(): void {
  lastReAddAt.clear();
  noRepairerAt.clear();
}

/**
 * Forgets every "nobody could repair this" verdict, because somebody came online.
 *
 * **THE EDGE THAT NEGATES THE VERDICT, APPLIED TO BOTH RECORDS THAT HOLD ONE.** `no_peer_online` is
 * one server answer - it read the roster and found nobody to forward to - and this device writes it
 * down twice: here, keyed by the epoch pair it was proved against, and in `historyReconcile` as a
 * deferred reconciliation. Only the second was discharged when a peer returned, so a locked-out
 * group waited for one of its two numbers to move, which needs the returning member to run a repair
 * this device cannot require of it. They are different records - one is a proof about a pair of
 * epochs, the other a note that an ask never went out - and they are not one map. What they share is
 * the EDGE, and an edge honoured by one of two records is how a session-long dead end survives.
 *
 * It clears the whole map rather than the groups of the users named by the edge: presence is
 * per-USER and this record is per-GROUP, and the membership that would join them is the roster this
 * device cannot read while it is locked out. The cost of being generous is bounded by the throttle
 * the caller left armed - one attempt per group per {@link RECOVERY_TIMEOUT_MS}, whatever asks.
 *
 * `lastReAddAt` is deliberately NOT cleared with it: the throttle answers "how often may this device
 * ask", which no peer's arrival changes, and clearing it would let a presence flap turn every
 * locked-out group into a pass per edge.
 */
export function forgetProvenDeadEnds(log: (msg: string) => void): void {
  if (noRepairerAt.size === 0) return;
  log(
    `[READD] a peer came back online - ${noRepairerAt.size} group(s) recorded as unrepairable will ` +
      `be asked again on the next pass`
  );
  noRepairerAt.clear();
}

/**
 * Re-asks the ONE question whose answer can have changed, for a group already recorded as having no
 * reachable repairer.
 *
 * **THE VERDICT IS ABOUT WHO IS ONLINE, AND THE PAIR IS NOT EVIDENCE FOR THAT QUESTION.** The two
 * epochs say whether the GROUP moved; the answer this record holds says whether any MEMBER DEVICE
 * was reachable, and a member connecting changes it with neither number moving. Waiting only on the
 * pair reads one column for a question it was never written to answer - so it needed a second exit,
 * and the second exit was a presence EDGE ({@link forgetProvenDeadEnds}) fired from a store whose
 * watchlist is assembled by the chat UI: `ConversationTile` and `ChatHeader` subscribe only for a
 * DIRECT conversation's peer, `ChannelMembersList` for an open channel's members, and `unwatchUsers`
 * stops the poll outright when the set empties. **A GROUP CONVERSATION PUTS NOBODY ON THAT LIST**,
 * which is the shape of the population this record was built for: production 2026-09-12, group
 * `4f87267a` answered `NO_PEER_ONLINE members=1` to twenty-seven consecutive minutes of asks, and
 * three more groups had been in that state since 2026-08-29, 08-30 and 08-31.
 *
 * **THE SERVER'S OWN DESIGN ASSUMES THIS ASK.** `notifyBaseRefreshRequest` stores nothing for an
 * offline member and says why: *"a base refresh is idempotent and cheap, the requester re-asks on
 * its own cadence as long as it still cannot join"*. That premise shipped on 2026-09-04 and the
 * record removed it on 2026-09-12 - two locally correct decisions that compose into no exit at all.
 * This restores it, at ONE HTTP call per {@link RECOVERY_TIMEOUT_MS} per group rather than the four
 * the full pass costs: the memberships, the conversation row and the join are all still decided by
 * the pair, and only the election is not.
 *
 * A refusal leaves the record standing - nothing changed. An election that found somebody DISCHARGES
 * it, so the next pass runs whole and the elected member's republish moves `baseEpoch` under it.
 * A request that never reached the server proves nothing about who is reachable and discharges
 * nothing, for the reason the `stale_base` branch gives its own catch.
 */
async function reAskTheElection(groupId: string, deps: RecoveryDeps): Promise<void> {
  let asked;
  try {
    asked = await deps.mlsService.sendBaseRefreshRequest(groupId);
  } catch (e) {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... re-ask of the base-refresh election did not reach the ` +
        `server: ${String(e).slice(0, 120)} - the dead end stands, nothing was learnt`
    );
    return;
  }
  if (asked.noPeerOnline) return;
  noRepairerAt.delete(groupId);
  deps.log(
    `[READD] ${groupId.slice(0, 8)}... a member is reachable again - the server elected ` +
      `${asked.target ?? 'one'} to republish the base, so the next pass runs whole`
  );
}

/** The groups recorded as having no reachable repairer, and the pair each was proved against. */
export function provenDeadEnds(): Array<[string, string]> {
  return [...noRepairerAt];
}

/**
 * Minimal dependencies required by the recovery functions.
 * Subset of MessageHandlerDeps - the two are compatible.
 */
export interface RecoveryDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  /** The session's CURRENT device key, read at use - see `MessageHandlerDeps.deviceKey`. */
  deviceKey: () => string;
  conversations: SvelteMap<string, Conversation>;
  getSelectedContact: () => string | null;
  setSelectedContact: (id: string | null) => void;
  saveConversation: (key: string) => Promise<void>;
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * The conversation carrying `groupId`, found BY ITS `id` rather than by its map key.
 *
 * Written on 2026-09-01 on the premise that a DM learnt from a Welcome is keyed by the PEER'S USER
 * ID. THE 2026-10-04 AUDIT REFUTED THAT PREMISE: every writer of the map keys a row by its own `id`
 * (the group id, or `channel_<id>`) - boot restore, both creation paths and the Welcome's
 * `upsertConversation`, which re-keys a peer-matched DM onto the joined group - so
 * `conversations.get(groupId)` and this scan answer the same thing. It stays because reading by
 * `id` is correct whatever the key is, and every lookup in this module goes through it; the writer
 * enumeration and the consumer verdicts are in `docs/wiki/frontend/modules/chat.md`
 * ("One key per conversation").
 */
function findByGroupId(
  conversations: SvelteMap<string, Conversation>,
  groupId: string
): [string, Conversation] | undefined {
  return [...conversations.entries()].find(([, c]) => c.id === groupId);
}

/**
 * Removes the local residue of a group CONFIRMED ABSENT from the server: forgets the residual
 * WASM MLS state (if any) and deletes the local conversation. EXCEPTION (rules 2 & 4): a
 * conversation marked `deletedRemotely` (deleted by a peer / exclusion) stays until a LOCAL
 * MANUAL DELETION, even if the server has hard-purged its row - we do not touch it.
 *
 * @returns `true` if the WASM MLS state was mutated (caller must then persist).
 */
async function purgePhantomConversation(groupId: string, deps: RecoveryDeps): Promise<boolean> {
  const entry = findByGroupId(deps.conversations, groupId);
  if (entry?.[1].lifecycle === 'removed') return false; // kept until manual local deletion
  const mutated = holdsGroupState(deps.mlsService, groupId);
  if (mutated) {
    await dropGroupState(deps.mlsService, groupId, {
      reason: 'phantom conversation purged',
      checkpoint: 'awaited',
      log: deps.log,
    });
  }
  if (entry) {
    await purgeLocalConversationRecord({
      conversations: deps.conversations,
      contactKey: entry[0],
      groupId,
      userId: deps.userId,
      deleteConversation: deps.deleteConversation,
      log: deps.log,
    });
  }
  return mutated;
}

/**
 * THE TERMINATION OF A RECOVERY, and the only seam that performs one.
 *
 * Exactly two server answers END a recovery instead of deferring it: the group was TOMBSTONED, and
 * the server says WE HOLD NO MEMBERSHIP ROW. Neither can be changed by trying again, so both retire
 * the conversation - and retiring it is what makes the loop terminate on a PROOF rather than on a
 * throttle. Step 1 of {@link requestReAdd} returns immediately for a `removed` conversation, and
 * `clearGroupNotReady` drops the group from what the SYNC_WATCHDOG enumerates, so nothing re-arms it.
 *
 * Written once because the SECOND caller is the whole point. The not-a-member answer had no branch
 * at all: it arrived as a bare `false` from `externalJoin`, indistinguishable from "no GroupInfo
 * published yet", fell through to the welcome_request fallback, and was re-asked every minute for as
 * long as the group existed - a 403 and a broadcast per minute, ending only if somebody else deleted
 * the group. GRP-6 caught it on 2026-08-24 because it watches for thirty seconds after a leave.
 *
 * A NEVER-ADMITTED ROW IS REMOVED, NEVER RETIRED - the decision discovery takes for the same row
 * (`discoverMissingGroups`, "the ask was declined or expired"). An ask no member answered left no
 * past and no exclusion to explain, and a `removed` row is a conversation the user sees listed:
 * retiring it was the ADM-2 symptom (2026-10-25).
 */
async function stopRecovering(groupId: string, reason: string, deps: RecoveryDeps): Promise<void> {
  cancelReAdd(groupId);
  clearGroupNotReady(deps.userId, groupId);
  const entry = findByGroupId(deps.conversations, groupId);
  if (!entry || entry[1].lifecycle === 'removed') return;
  if (isNeverAdmitted(entry[1])) {
    deps.log(`[READD] ${groupId.slice(0, 8)}... ${reason} - a never-admitted ask ended, removing`);
    await purgeLocalConversationRecord({
      conversations: deps.conversations,
      contactKey: entry[0],
      groupId,
      userId: deps.userId,
      deleteConversation: deps.deleteConversation,
      log: deps.log,
    });
    return;
  }
  deps.log(`[READD] ${groupId.slice(0, 8)}... ${reason} - marking removed`);
  await retireConversation({
    conversations: deps.conversations,
    key: entry[0],
    groupId,
    saveConversation: deps.saveConversation,
    patch: { id: groupId },
  });
}

/** What the caller of {@link requestReAdd} already knows, and the seam cannot read. */
export interface ReAddOptions {
  /**
   * This device has just HANDLED a Welcome for the group and could not join from it
   * (`NoMatchingKeyPackage`, `GroupAlreadyExists`). The handler returns - and the drain ACKs that
   * Welcome - only after this recovery has started, so the server can still list it as queued; a
   * queued Welcome is then not evidence that one is coming, and is read past
   * (`readWelcomeOwedFromRow`'s `ignoreQueuedWelcome`). Without it the device waited a whole
   * cadence for the Welcome it had just spent.
   *
   * IT READS PAST EVERY QUEUED WELCOME OF THE GROUP, NOT ONLY THE SPENT ONE - the row is a boolean
   * and cannot tell them apart - and that is safe because the door it opens is guarded where it
   * acts: a second Welcome the drain applies first makes `externalJoin` stand down under the MLS
   * lock (`alreadyHeld`), and an external commit that lands first replaces the leaf the second
   * Welcome's Add wrote for the same key (review of #2466).
   */
  welcomeHandled?: boolean;
}

/**
 * Recovers `groupId` when the local MLS state is absent or out of sync. Single recovery ACTION seam,
 * self-throttled via {@link RECOVERY_TIMEOUT_MS}; the SYNC_WATCHDOG drives the cadence, reactive
 * paths call it on demand. No private timer, no reboot/successor - the self-service external-commit
 * join replaced the CAS/successor machinery.
 *
 * Flow:
 *  1. Conversation already marked dead -> return (idempotent).
 *  2. Throttled (< RECOVERY_TIMEOUT_MS since the last attempt) -> return.
 *  3. Group CONFIRMED ABSENT server-side -> purge the local phantom, stop.
 *  4. Group already in local WASM -> nothing to recover (caller must forgetGroup first if forked).
 *  5. Group tombstoned (`deletedAt`) -> mark the conversation removed, stop.
 *  6. A member ALREADY OWES us a Welcome (`pending`, with a Welcome queued or an add in flight) ->
 *     wait for it, ask nobody, stop; a link's seat awaiting admission -> ask a member, stop. The
 *     external join below is not ours to make while an Add is in flight for our own leaf. NO row for
 *     this device -> the account's seat decides: none on a believable list -> stop (no row created,
 *     no join, no ask).
 *  7. Try the self-service external-commit join (Phase 4).
 *  8. The server REFUSED it as a non-member (`NotAGroupMemberError`) -> mark the conversation
 *     removed, stop. This is a terminating ANSWER and not a failed attempt, which is the difference
 *     between this seam terminating on a proof and terminating only when the group gets deleted.
 *  9. Any other failure -> fall back to a single welcome_request (a reachable member re-adds us).
 *     The watchdog re-invokes on its cadence.
 */
export async function requestReAdd(
  groupId: string,
  deps: RecoveryDeps,
  opts: ReAddOptions = {}
): Promise<void> {
  // Idempotence: an already-dead conversation does not restart a network recovery.
  const known = findByGroupId(deps.conversations, groupId)?.[1];
  if (known?.lifecycle === 'removed') return;

  // Throttle: this seam is invoked by the watchdog every poll and by reactive paths on demand.
  // Cap it to one attempt per RECOVERY_TIMEOUT_MS per group. The marker is set only once we commit
  // to an attempt (below), so a first call is never blocked.
  const now = Date.now();
  const sinceLast = now - (lastReAddAt.get(groupId) ?? 0);
  if (sinceLast < RECOVERY_TIMEOUT_MS) {
    deps.log(`[READD] ${groupId.slice(0, 8)}... throttled (${Math.round(sinceLast / 1000)}s ago)`);
    return;
  }

  // Entry log, and it earns its noise: the throttle above returns silently, so an attempt that got
  // stuck on one of the network calls below was indistinguishable from one that never started.
  // Measured on the device 2026-08-06 - `requestReAdd` never returned and never logged a thing.
  //
  // THE AGE IS THE HALF THAT ACCUSES. Every attempt logged the same sentence, so a group on its
  // first pass and one that had been waiting five days read identically - and the second is the
  // stranded population `reportStrandedDeviceMemberships` names hourly on the server, with nothing
  // saying it client-side. The registry already stored the instant; nothing read it.
  const notReadySince = readNotReadySince(deps.userId, groupId);
  deps.log(
    `[READD] ${groupId.slice(0, 8)}... attempt starting` +
      (notReadySince === undefined
        ? ''
        : ` (not ready for ${formatWaitedFor(now - notReadySince)})`)
  );

  // AN EXPLICIT TRY RATHER THAN `.catch(() => null)`, FOR TWO REASONS AND BOTH ARE RULES HERE.
  //
  // EVERY SWALLOWED BRANCH LOGS. The old form turned a throw into a value and said nothing about
  // it; the line below reports the OUTCOME (`null`) and the outcome is deliberately ambiguous -
  // absent group and network error both land on it, which `getGroupServerStatus` then separates.
  // What was lost was the CAUSE, and that is not recoverable anywhere downstream.
  //
  // AND THE NULL IS NOW VISIBLE, WHICH IS HOW THE REAL DEFECT SURFACED. `.catch(() => null)`
  // widened the awaited type in a way a static analyser does not follow; writing the try out made
  // `GroupMeta | null` explicit, and the analyser then held its ground on
  // `'meta' cannot be of type null, but it is compared to an expression of type null` - about the
  // join guard two hundred lines down, NOT about the branch below. It was right: every path out
  // of that branch returns, so `meta` is a `GroupMeta` from there on and the second null check was
  // dead. Both dead checks are gone; this one is the live one - and the COMPILER is what keeps
  // that true: delete any `return` from the branch below and `bun run check` fails at the three
  // sites that then read `meta` unguarded (measured, not assumed).
  let meta: GroupMeta | null = null;
  try {
    meta = await deps.mlsService.getGroupMeta(groupId);
  } catch (error) {
    deps.log(`[READD] ${groupId.slice(0, 8)}... getGroupMeta threw: ${String(error)}`);
  }
  deps.log(`[READD] ${groupId.slice(0, 8)}... getGroupMeta -> ${meta === null ? 'null' : 'ok'}`);

  // No server metadata: `getGroupMeta` returns null for both absent groups and network errors, so
  // resolve the ambiguity - `getGroupServerStatus` distinguishes a CONFIRMED ABSENT (no dm_groups
  // row) from a transient network error.
  if (meta === null) {
    deps.log(`[READD] ${groupId.slice(0, 8)}... getGroupServerStatus…`);
    const status = classifyServerStatus(
      await deps.mlsService.getGroupServerStatus(groupId).catch(() => 'error' as const)
    );
    deps.log(`[READD] ${groupId.slice(0, 8)}... serverStatus -> ${status.kind}`);
    if (status.kind === 'absent') {
      // The group no longer exists AT ALL server-side. Purge the local phantom instead of
      // re-emitting recovery indefinitely for a group that does not exist and is invisible in the UI.
      deps.log(`[READD] ${groupId.slice(0, 8)}... absent from server (confirmed) - phantom purged`);
      cancelReAdd(groupId);
      clearGroupNotReady(deps.userId, groupId);
      if (await purgePhantomConversation(groupId, deps))
        await persistMlsStateAfterMutation(
          deps.mlsService,
          deps.userId,
          deps.deviceKey(),
          deps.log
        );
      return;
    }
    // Transient network error: skip this round, the watchdog retries on its cadence.
    //
    // AND IT NOW REALLY DOES SKIP. This branch fell through and attempted the join anyway, on a
    // group whose server row could not be read - so the conversation the join makes this device
    // reachable for could not be described either (see the block before `externalJoin`: `isGroup`
    // decides whether the row is a DM, and guessing it is guessing the row's name and its key).
    // Nothing is lost by waiting one cadence for an answer that is the input to both steps.
    //
    // THE COOLDOWN IS ARMED THOUGH NO ATTEMPT WAS MADE, and that half is not optional. The
    // watchdog invokes this seam every FIVE seconds; the two probes above are what it costs to
    // reach this line, so returning without arming anything turns an unreachable server into two
    // HTTP round trips every five seconds for as long as it stays unreachable. `markGroupNotReady` is
    // deliberately NOT set with it: that marker means "this device owes a recovery", and what this
    // branch knows is only that it could not ask.
    lastReAddAt.set(groupId, now);
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... server metadata unreadable - deferring the join one round`
    );
    return;
  }

  if (holdsGroupState(deps.mlsService, groupId)) {
    clearGroupNotReady(deps.userId, groupId);
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... already in WASM - skip (call forgetGroup before recovery if out of sync)`
    );
    return;
  }

  // Tombstoned server-side: mark the conversation removed, stop recovering. `meta` is not optional
  // here - the branch above returns on every path - so this reads it directly.
  if (meta.deletedAt) {
    await stopRecovering(groupId, 'deleted server-side', deps);
    return;
  }

  if (isDistributionGroupMeta(meta)) {
    deps.mlsService.noteDistributionGroup(groupId);
    cancelReAdd(groupId);
    clearGroupNotReady(deps.userId, groupId);
    deps.log(`[READD] ${groupId.slice(0, 8)}... distribution group - no conversation created`);
    return;
  }

  // A DEAD END THE SERVER ALREADY PROVED - THREE OF THE FOUR ANSWERS ARE KNOWN, AND THE FOURTH IS
  // THE ONLY ONE WORTH ASKING.
  //
  // The pass below costs four HTTP calls: the memberships, the conversation row, the join, and the
  // base-refresh ask. The first three are decided by two numbers this pass has ALREADY read on the
  // call above, so while the pair stands they are known before they are asked. The fourth is NOT:
  // it is an election over the members who are ONLINE, and a member connecting changes its answer
  // with neither number moving. So the record skips the three and re-asks the one -
  // {@link reAskTheElection}, which the server's own design assumes and which discharges the record
  // the moment somebody is reachable. See {@link noRepairerAt} for the pair and what it does prove.
  //
  // THE THROTTLE IS STILL ARMED, AND THAT HALF IS NOT OPTIONAL. The watchdog invokes this seam
  // every five seconds; `getGroupMeta` above is what it costs to reach this line, so returning
  // without arming anything would turn a locked-out group into one HTTP round trip every five
  // seconds instead of one a minute. `markGroupNotReady` is deliberately NOT set with it: the marker means "this
  // device owes a recovery", and this device is not owing one, it is waiting for somebody to exist.
  const pair = epochPair(meta);
  const proven = noRepairerAt.get(groupId);
  if (proven !== undefined && pair !== undefined && proven === pair) {
    lastReAddAt.set(groupId, now);
    await reAskTheElection(groupId, deps);
    return;
  }
  if (proven !== undefined && proven !== pair) {
    // AND IT SAYS SO WHEN IT LEAVES, because "the group moved" is the event this whole record
    // exists to wait for, and a dead end that ends in silence is indistinguishable from one that
    // was never entered.
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... the group moved since nobody could repair it ` +
        `(${proven} -> ${pair ?? 'unknown'}) - trying again`
    );
    noRepairerAt.delete(groupId);
  }

  // Commit to an attempt: arm the throttle and the persistent not-ready marker (the SYNC_WATCHDOG
  // enumerates it to drive the cadence).
  lastReAddAt.set(groupId, now);
  markGroupNotReady(deps.userId, groupId);

  // THE FACT THAT DECIDES WHICH OF THE TWO JOIN PATHS IS OURS, READ WHERE IT IS ALREADY WRITTEN.
  //
  // `pending` means a member has been told to Add this device and OWES it a Welcome - the state the
  // invitation flow writes the moment a link is accepted. `active` means this device joined once and
  // may since have lost its local state, which is the ONLY population the self-service external
  // join was ever written for. Both used to arrive here indistinguishable, so an invited device
  // served itself an external commit while the Add was in flight: two parties then held the same
  // leaf in the same tree, the member's `addMember` failed `DuplicateSignature`, and its handler
  // kicked our LIVE leaf - a Remove commit evicting us from the group we had just joined. Measured
  // on 2026-08-26 (GRP-4): the invitation link and this seam raced on every join by link, and the
  // joiner lost about half of them. The overlap is deleted here rather than reconciled afterwards,
  // because a ledger repairing two parties that wrote the same leaf is a witness, not a fix.
  //
  // AND A LINK'S SEAT IS AN ASK (`awaiting-admission`): a new person enters by a member's Add, so
  // the self-service door is shut for them - the server refuses the base and the commit. Told here,
  // before anything is tried, the device asks a member and waits; the member it
  // reaches is shown "X asks to join" (`handleWelcomeRequest`).
  let reading = await readWelcomeOwed(groupId, deps, opts);
  if (reading === null) {
    // The discriminator could not be read, so neither path is known to be ours. The watchdog owns
    // the cadence and re-invokes; guessing here is the exact move this block exists to stop.
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... membership status unreadable - skipping this round`
    );
    return;
  }
  // NO ROW FOR THIS DEVICE: WHETHER THE ACCOUNT HOLDS A SEAT DECIDES, AND IT IS READ, NOT LEARNT BY
  // FAILING (ADM-2, 2026-10-25). This branch used to fall through to the self-service join as if the
  // row were `active`, so a pass entered after an ask was DECLINED - its device row deleted with the
  // seat - re-created the placeholder and tried an external join the server refused with a 403,
  // leaving the conversation listed as `removed`. The account's seat is on the list discovery reads,
  // and that list says so before anything is built or published.
  if (reading === 'no-device-row') {
    const seat = await readAccountSeat(groupId, deps);
    if (seat.kind === 'unknown') return;
    if (seat.kind === 'none') {
      // THE LIST ENDS ONLY WHAT IT CAN SPEAK FOR: a group this device holds no conversation for (a
      // registry-only candidate), or a never-admitted row - an ask that ended. A row this device was
      // ever IN is decided on a per-group read, never on list absence alone - the reader and the
      // reducer discovery uses for the same row ({@link endOnTheGroupsOwnAnswer}).
      const convo = findByGroupId(deps.conversations, groupId)?.[1];
      if (convo !== undefined && !isNeverAdmitted(convo)) {
        if ((await endOnTheGroupsOwnAnswer(groupId, convo, meta, deps)) === 'done') return;
      } else {
        deps.log(
          `[READD] ${groupId.slice(0, 8)}... the server lists no seat for this account in the group - ` +
            `nothing to join, no member to ask (an ask declined or expired, or a removal); recovery ends`
        );
        await stopRecovering(groupId, 'the server lists no seat for this account', deps);
        return;
      }
    } else {
      // The account is seated. The list carries this device's seat too when the server has one, read
      // AFTER the memberships above - so it reclassifies the pass rather than being discarded; with no
      // seat there, this device's door is its own, as an `active` row's.
      // NO SEAT FOR THIS DEVICE AT ALL, ON EITHER READ, goes on to the join below like any other:
      // whether it is a further device of a member is read off the tree its commit would be built
      // on (`asAFurtherDevice`), never off the server's rows.
      const listed = seat.row.deviceMembership;
      if (listed) {
        deps.log(
          `[READD] ${groupId.slice(0, 8)}... no row for this device on the first read, the account's list ` +
            `names one (${listed.status}) - reading that seat`
        );
        const fromList = classifyOwnSeat(
          groupId,
          {
            id: '',
            userId: deps.userId,
            deviceId: deps.mlsService.getDeviceId(),
            groupId,
            status: listed.status,
            welcomeQueued: listed.welcomeQueued,
            addInFlight: listed.addInFlight,
            awaitingAdmission: listed.awaitingAdmission,
          },
          listed.admitted ? '(the list does not carry the epoch)' : null,
          opts.welcomeHandled === true,
          deps
        );
        // The same verdict as the first read's: a seat that does not answer skips the round.
        if (fromList === null) return;
        reading = fromList;
      }
    }
  }
  if (reading === 'awaiting-admission') {
    await askAMemberToReAddUs(groupId, deps, "invited by a link, awaiting a member's admission");
    return;
  }
  // A WELCOME THAT IS COMING IS WAITED FOR, NEVER ASKED FOR AGAIN (DUP-2, 2026-10-25).
  //
  // Two readings say somebody else's Welcome is the door. A `welcome_request` on top of any of
  // them asked every member to redo work already under way: a member finding the add lock held
  // logged `Lock busy` and stood down, and a member finding it free would have REPLACED this
  // device's leaf - a second commit, a second Welcome, the first one invalidated. Measured on DUP-2:
  // a joiner whose first frame was a member's commit (the server routes an admitted device every
  // frame of its epoch, and must) asked for a re-add five seconds before the adder delivered the
  // Welcome it owed.
  //
  // So the device waits, on the facts and not a clock: the not-ready marker above keeps the group on
  // the SYNC_WATCHDOG's cadence, every pass re-reads the row, and once no fact holds the reading is
  // `unhonoured-seat` and the self-service door below is this device's. The frames that arrived
  // first stay buffered and in the server queue, and the Welcome handler replays them. The Graine
  // key-group join has waited on the same readings since 2026-09-27 (`ensureDistributionGroupFor`).
  if (reading === 'welcome-queued') {
    // THE WELCOME IS IN THIS DEVICE'S OWN MAILBOX, so the mailbox is where to look. A pull reads it
    // now rather than whenever the next push or reconnect happens to.
    //
    // ONLY THE LEADER TAB PULLS: the mailbox is drained where the ratchet lives, and a pull asked
    // from a follower is refused as a caller that forgot to ask (`fetchPendingMessages`). A follower
    // has nothing to do here - the leader's own recovery reads the same row.
    if (getTabLeadership() === 'follower') {
      deps.log(
        `[READD] ${groupId.slice(0, 8)}... a Welcome is queued for this device - a follower tab does not pull, the leader drains it`
      );
      return;
    }
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... a Welcome is queued for this device - pulling the mailbox, no member asked`
    );
    void deps.mlsService
      .fetchPendingMessages()
      .catch((e: unknown) =>
        deps.log(
          `[READD] ${groupId.slice(0, 8)}... mailbox pull for the queued Welcome failed: ${String(e).slice(0, 120)}`
        )
      );
    return;
  }
  if (reading === 'add-in-flight') {
    // SOME member holding this group's add lock - the lock is per group, so the Add may be for
    // another device; the next pass after its release reads which.
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... a member holds the add lock - waiting for it to settle, no member asked`
    );
    return;
  }

  // THE ROW BEFORE THE LEAF, AND THE ORDER IS THE WHOLE OF THIS BLOCK.
  //
  // `externalJoin` PUBLISHES our leaf: from the instant it returns, every member may address this
  // group and the delivery service routes to us - while a frame arriving for a group this device
  // holds no conversation row for is answered `false` and left in the server queue. So the two
  // facts are not interchangeable, and one strictly precedes the other: a device must not become
  // REACHABLE for a group it cannot yet ROUTE for.
  //
  // It used to take its row from `discoverMissingGroups`, a different sweep over the same server
  // list, running fire-and-forget on its own cadence - so the order was decided by whichever
  // finished first. Measured on HEAL-REVOKE-4 (2026-09-06): the join won by five seconds, and the
  // member's answer to this device's OWN history solicitation - sent in the same second as the join
  // - landed in the gap. The Welcome path never had it, because `setupMessageHandler` writes the
  // row inside the lock that installs the group; this is that same step, for this path.
  //
  // A REFUSAL IS NOT A REASON TO JOIN ANYWAY. `exit-owed` is a decision this device already took
  // and terminates the recovery on that proof; the other two clear by themselves and the watchdog
  // re-invokes this seam on its cadence. Joining first would buy nothing but the window above.
  //
  // `isGroup` IS READ, NEVER DEFAULTED. It decides whether the row is a DM, which decides its
  // display name and its peer - so `undefined` is a question the server did not answer, not a
  // "no". The column is non-null server-side and the response carries the whole entity, so this
  // branch is an anomaly worth a line rather than a case to paper over with a default.
  if (meta.isGroup === undefined) {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... join deferred - the server row does not say whether this is a DM`
    );
    return;
  }
  const routable = await ensureConversationForServerGroup(
    { groupId, name: meta.name, isGroup: meta.isGroup },
    {
      mlsService: deps.mlsService,
      userId: deps.userId,
      conversations: deps.conversations,
      saveConversation: deps.saveConversation,
      owedExits: await pendingGroupExitIds(deps.storage),
      log: deps.log,
    }
  );
  if (routable === 'exit-owed') {
    // Not `stopRecovering`: there is no conversation to retire, and the exit drain - not this seam -
    // owns what happens next. Dropping the bookkeeping is what stops the watchdog enumerating a
    // group this device is on its way out of, every five seconds, for as long as the exit is owed.
    cancelReAdd(groupId);
    clearGroupNotReady(deps.userId, groupId);
    return;
  }
  if (routable !== 'existed' && routable !== 'created') {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... join deferred - nothing could route for it yet (${routable})`
    );
    return;
  }

  // Self-service external-commit join first (Phase 4): fetch the stored GroupInfo and rejoin at the
  // current epoch without a peer. On success, clear the recovery bookkeeping and return.
  deps.log(`[READD] ${groupId.slice(0, 8)}... externalJoin…`);
  let outcome: ExternalJoinOutcome;
  try {
    // A FURTHER DEVICE OF A MEMBER (2026-10-27) - the tree holds a leaf of its user and none of its
    // own - is not let in by its own commit: the join answers `further_device` and the device asks
    // a member below, whose device shows it and its key. Read off the very GroupInfo the commit
    // would be built on, so an honest device never makes the entry members say as nobody's.
    outcome = await deps.mlsService.externalJoin(groupId, { asAFurtherDevice: 'ask' });
  } catch (e) {
    // A STATUS CODE IS AN ANSWER. The server holds no membership row for us, so there is no base to
    // join and no point asking a member to re-add us - the group's own roster is what refused. This
    // is the proof this loop never had: the refusal used to arrive as a bare `false`, land in the
    // welcome_request fallback below, and come back every minute until the group was deleted.
    if (e instanceof NotAGroupMemberError) {
      await stopRecovering(groupId, 'server holds no membership row for us', deps);
      return;
    }
    // Anything else says NOTHING about membership, so it must not retire a conversation: the
    // fallback below stays the right next move, and the log is what keeps the branch from being
    // silent on the path a real outage would take.
    deps.log(`[READD] ${groupId.slice(0, 8)}... externalJoin threw: ${String(e).slice(0, 120)}`);
    outcome = { joined: false, reason: 'unreachable' };
  }
  // The REASON is logged, not just the verdict. A chat group falls back to welcome_request for every
  // refusal - a peer can Welcome us where a distribution group has nobody to ask - so the branch
  // does not fork here; what it must not do is leave the five causes indistinguishable in the log,
  // which is where `stale_base` (a base no retry can ever use) hid as an ordinary lost race.
  deps.log(
    `[READD] ${groupId.slice(0, 8)}... externalJoin -> ${outcome.joined ? 'joined' : outcome.reason}`
  );
  if (outcome.joined && outcome.alreadyHeld) {
    // THE GROUP WAS ALREADY HELD WHEN THE JOIN TOOK THE MLS LOCK, and nothing was built (review of
    // #2466). Usually a Welcome installed it while this recovery was on its way; or the engine held
    // it all along and this service's list missed it (the engine's typed refusal - a stale list
    // after a PIN recovery on native), in which case NO Welcome ran and nothing else will touch the
    // roster seat.
    //
    // SO THE SEAT IS PROMOTED HERE, whichever it was - the deterministic end of the row - but ONLY
    // ON PROOF THAT OUR LEAF IS IN THE TREE WE HOLD. The server cannot check that: a self-report
    // promotes an existing seat that is not kicked and whose owner is a member - an admitted roster
    // seat, or in a key-distribution group an entitlement social-service gives
    // (`promoteReportedSeat`) - and it cannot read the tree, so the proof is ours to carry. Holding the state is not it - an evicted group stays held
    // (`isGroupActive`) - and a held, active group is: `active` is then the truth, and a `pending`
    // row left behind is served to every member as a work item, so the next one online would Add a
    // leaf already in the tree and its duplicate-leaf repair would kick the live one (the reason the
    // external-join branch below promotes). After a Welcome it is a second write of the same value:
    // the server's UPDATE matches again, logs one line and re-adds an existing route, and emits
    // nothing. Logged rather than thrown, as below.
    ownKeyPackageLogged.delete(groupId);
    clearGroupNotReady(deps.userId, groupId);
    cancelReAdd(groupId);
    const inTree = await deps.mlsService.isGroupActive(groupId).catch((e: unknown) => {
      deps.log(
        `[READD] ${groupId.slice(0, 8)}... held, but whether our leaf is in its tree could not be read: ${String(e).slice(0, 120)}`
      );
      return false;
    });
    if (!inTree) {
      deps.log(
        `[READD] ${groupId.slice(0, 8)}... the group was already held when the join took the lock - nothing built; our leaf is not proven in its tree, so the roster seat is left as it is`
      );
      return;
    }
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... the group was already held when the join took the lock - nothing built, roster seat promoted, recovery done`
    );
    await deps.mlsService
      .updateInvitationStatus(deps.mlsService.getDeviceId(), deps.userId, groupId, 'active')
      .catch((e) =>
        deps.log(
          `[READD] ${groupId.slice(0, 8)}... held, but the roster seat is still pending: ` +
            `${String(e).slice(0, 120)} - a member may try to Add a leaf already in the tree`
        )
      );
    return;
  }
  if (outcome.joined) {
    ownKeyPackageLogged.delete(groupId);
    deps.log(`[READD] ${groupId.slice(0, 8)}... rejoined via external commit (self-service)`);
    clearGroupNotReady(deps.userId, groupId);
    cancelReAdd(groupId);
    // THE ROSTER SEAT IS A WORK ITEM, AND JOINING BY OURSELVES DOES NOT CLEAR IT. `pending` is what
    // `getPendingInvitations` serves to every member: leaving it behind means the next member to come
    // online calls `addMember` for a leaf that is ALREADY in the tree, gets `DuplicateSignature`, and
    // its handler kicks the live leaf we just published - which is the duplicate-leaf repair firing
    // on a device that needed no repair. The Welcome path promotes the row (`setupMessageHandler`)
    // and the inviter's path promotes it (`processPendingInvitations`); this path never did, and it
    // is the path this commit makes reachable, so it owes the same write.
    //
    // Best-effort and LOGGED rather than thrown: the join has already landed and the group is live
    // locally, so failing here costs one wrongly-served invitation, not the conversation. A swallowed
    // branch with no line is all a loss leaves.
    await deps.mlsService
      .updateInvitationStatus(deps.mlsService.getDeviceId(), deps.userId, groupId, 'active')
      .catch((e) =>
        deps.log(
          `[READD] ${groupId.slice(0, 8)}... joined, but the roster seat is still pending: ` +
            `${String(e).slice(0, 120)} - a member may try to Add a leaf already in the tree`
        )
      );
    // External join does not go through the Welcome path that normally promotes the conversation:
    // the group is now live in WASM, so mark it active here so the UI leaves the "syncing" state
    // without waiting for a page reload.
    //
    // BY `id`, AND SAVED BY THE MAP KEY, through the module's one lookup ({@link findByGroupId}).
    // Every writer keys a row by its `id`, so the two are the same string today; the write takes the
    // key it found so that it stays right if that invariant ever breaks.
    const entry = findByGroupId(deps.conversations, groupId);
    if (entry && entry[1].lifecycle !== 'active') {
      deps.conversations.set(entry[0], { ...entry[1], lifecycle: 'active' });
      await deps.saveConversation(entry[0]).catch(() => {});
      // The row is usable from here, exactly as the Welcome path's is: what waited on it - a lost
      // invitation of this member's (`owedInvitations.ts`), frames left behind - is woken by the one
      // event that announces it.
      deps.mlsService.notifyConversationAvailable(groupId);
    }
    // An external join lands at the current epoch WITHOUT the pre-join history, which only a member
    // can re-encrypt. Nothing has to decide whether anything is actually missing any more - this
    // very path also runs for a device that merely rotated its MLS identity and whose store, keyed
    // by user, still holds the whole conversation, and the comparison answers "we agree" for it in
    // one frame. That guess used to be a durable marker, and getting it wrong was permanent.
    await reconcileGroup(deps.mlsService, groupId, deps.log);
    deps.log(`[READD] ${groupId.slice(0, 8)}... external-join path done`);
    return;
  }

  // No GroupInfo stored yet -> ask a reachable member to re-add us via a Welcome. The SYNC_WATCHDOG
  // re-invokes this on its cadence until we rejoin. "Or not an authorized member" used to be in this
  // sentence, and it was the bug: that case cannot be answered by any member and now exits at step 8
  // instead of arriving here.
  //
  // A STALE BASE WANTS A DIFFERENT FAVOUR, AND ASKING FOR THE WRONG ONE IS WHY IT NEVER HEALED.
  // `stale_base` means the published GroupInfo names an epoch the group has left: no retry can
  // satisfy it, because only a member holding the tree can mint a new base. The shared fallback
  // asked for a Welcome instead - which MUTATES the tree, takes the group's add lock and replays the
  // duplicate-leaf race, to obtain something this device did not need. What it needs is a read-only
  // publish that takes no lock and changes no epoch, after which it serves itself on the next pass.
  //
  // MEASURED ON PRODUCTION 2026-09-04, and this is not a hypothetical population: four of the
  // forty-three groups holding a base were stale, every one by exactly ONE epoch, two of them since
  // 2026-08-30 - with three devices sitting `pending` on those two, unable to join for five days. A
  // stale base does not drain itself: only a member's next commit republishes one, and a quiet
  // conversation has no next commit.
  //
  // The re-ask is the caller's existing cadence, not a retry here: the watchdog runs this seam again
  // while the device still cannot join, and each ask is forwarded to a randomly re-elected member,
  // so a responder whose own tree is behind does not absorb the request for ever.
  //
  // UNLESS THE SERVER SAYS THERE IS NOBODY TO RE-ELECT, which is an answer and not a failure. The
  // election is the server's, so it is the only party that knows whether a member was reachable,
  // and it says so. That verdict used to be discarded here and the whole pass repeated every
  // minute for the life of the session - see {@link noRepairerAt} for what that cost on production.
  if (outcome.reason === 'stale_base') {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... the published base is at epoch ${outcome.baseEpoch} and the group ` +
        `is at ${outcome.serverEpoch} - asking a member to REPUBLISH it, not to re-add us`
    );
    const asked = await deps.mlsService.sendBaseRefreshRequest(groupId).catch((e) => {
      deps.log(
        `[READD] ${groupId.slice(0, 8)}... base-refresh request did not reach the server: ` +
          `${String(e).slice(0, 120)}`
      );
      // A request that never arrived proves NOTHING about who is reachable, and reading silence as
      // "nobody" would stop a repair on a dropped packet. The next pass asks again.
      return { noPeerOnline: false };
    });
    if (!asked.noPeerOnline) return;
    // THE PAIR THE VERDICT WAS TAKEN AGAINST IS THE JOIN'S OWN, not the one read at the top of this
    // pass: `externalJoin` is the call the gate actually refused, and the two numbers it reports are
    // the ones that refused it. Reading the older pair would record a proof against a state nothing
    // was measured in.
    const provenAt = epochPair({
      baseEpoch: outcome.baseEpoch,
      activeEpoch: outcome.serverEpoch,
    });
    if (provenAt === undefined) return;
    noRepairerAt.set(groupId, provenAt);
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... no member is reachable to republish the base, so nothing ` +
        `this device does can open this group - waiting for either epoch to move (now ${provenAt})`
    );
    return;
  }

  // THIS DEVICE'S OWN KEYPACKAGE IS NOT PUBLISHED, so no member can Welcome it either - a Welcome is
  // built from that very package, and a request asking for one is hopeless until it exists. The
  // join already started or awaited the round that publishes it; the watchdog's next pass reads
  // the fact again. Typed, never message-matched.
  if (
    outcome.reason === 'own_key_package_unverified' ||
    outcome.reason === 'key_package_round_failed'
  ) {
    // Logged when the (group, reason) pair CHANGES: this pass runs about once a minute with no
    // repair in between, and a repeated line is a heartbeat, not news.
    if (ownKeyPackageLogged.get(groupId) !== outcome.reason) {
      ownKeyPackageLogged.set(groupId, outcome.reason);
      deps.log(
        `[READD] ${groupId.slice(0, 8)}... not asking a member to re-add us: this device's own KeyPackage is not published (${outcome.reason}) - not repeated until the reason changes or the group joins`
      );
    }
    return;
  }

  // A FURTHER DEVICE OF A MEMBER: its door is a member's Add, asked for here.
  // ASKED ON THE CADENCE, NOT ONCE: no answer the server gives makes the ask durable. A `forwarded`
  // ask lives on one member's screen, a `stored` one is drained to a member's screen at its next
  // connection, and a screen that reloads before deciding loses it; nothing on this device can see
  // that happen, so a record of "already asked" would strand the device in a quiet group. The member's
  // device adds it with no one asked (`automaticAdmission`: the gate is on the user). The durable
  // shape - the request as a server row, re-read by every member's sweep - is on the backlog.
  if (outcome.reason === 'further_device') {
    await askAMemberToReAddUs(
      groupId,
      deps,
      "a further device of a member - a member's Add, not this device's own join"
    );
    return;
  }
  // THE SERVER REFUSED THIS ACCOUNT'S COMMITS FOR A WHILE (`429`, `commitRateLimit.ts`): the base is
  // fine and nobody needs to re-add us, so asking a member for a Welcome would mutate the tree to
  // work around a wait. The watchdog's next pass joins again once the wait has passed.
  if (outcome.reason === 'rate_limited') {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... not asking a member to re-add us: the commit rate limit holds for ${Math.round(outcome.retryAfterMs / 1000)} s more`
    );
    return;
  }

  // WHAT REACHES HERE IS THEREFORE BOUNDED BY SOMETHING: a group whose base is unpublished has a
  // member who will publish one, or a peer who can send a Welcome. Nothing that reaches this line
  // any longer has a server-side answer proving the request is hopeless.
  await askAMemberToReAddUs(groupId, deps, `external join refused: ${outcome.reason}`);
}

/**
 * Answers "does a member already owe this device a Welcome for `groupId`, RIGHT NOW?" from the
 * server's own per-device membership row and the two facts the row cannot carry.
 *
 * `null` IS NOT A "NO": it says the question could not be answered - the request failed, or the row
 * did not carry the facts. Collapsing `null` into "nobody owes us" is precisely the mistake this
 * seam exists to stop making: it would send the invited
 * population back down the external-join path on exactly the network conditions where losing the
 * race is likeliest. `getDeviceMemberships` rejects rather than answering `[]` so that this function
 * can tell the two apart at all.
 *
 * **`pending` ALONE USED TO BE THE ANSWER, AND IT IS A STATE READ AS AN EVENT.** The row says a
 * member has been TOLD to Add this device; it says nothing about anyone doing it. So a device that
 * enrolled while nobody was online - which writes one `pending` row per conversation of its user and
 * nothing else - read "a member owes me a Welcome" about every one of them, returned here before
 * reaching the self-service external join, and asked again every 60 s for as long as it stayed open.
 * Measured on production 2026-09-03: eleven groups, ten hours, 552 requests, zero queued Welcomes,
 * `updatedAt` never moved; and reproduced on the local estate 2026-09-04 on four groups whose
 * external-join base was published the whole time. The device could have joined every one of them by
 * itself. **The gate itself is right and stays** - it is what deleted the GRP-4 duplicate-leaf race
 * of 2026-08-26 - it simply had no way to tell "in flight for 200 ms" from "registered yesterday and
 * never honoured", and the fact that separates them was already known server-side.
 *
 * **THE TWO NEW FACTS, AND WHY BOTH ARE NEEDED.** `welcomeQueued` says a Welcome is really sitting
 * in the queue for this device and this group, so it will arrive the moment delivery runs -
 * `reportStrandedDeviceMemberships` has partitioned on exactly this since 2026-09-01. `addInFlight`
 * says a member holds this group's add lock, which is the window a queued Welcome does not yet cover:
 * every Add path takes the lock BEFORE writing the roster row and releases it after the Welcome is
 * queued, so `welcomeQueued` alone would let the requester race a legitimate Add and re-open GRP-4.
 * Together they are true for every `pending` row somebody is actually working on, and false only for
 * a roster seat nothing follows.
 *
 * **A ROW THAT DOES NOT SAY IS NOT A ROW SAYING NO.** Every deployed server writes both facts on a
 * pending row since 2026-09-03, so a row missing either is an anomaly: it reads `null`, the pass is
 * skipped as if the request had failed, and the line accuses. Treating a missing field as `false`
 * would hand the invited population the external join, which is the race, not the fix.
 *
 * @returns the reading ({@link WelcomeOwedReading}) - `awaiting-admission` included, the invitation
 *   link's seat that only a member's Add answers - `no-device-row` when the server holds no row for
 *   this device in the group, or `null` when the memberships could not be read or this device's
 *   pending row did not answer.
 */
async function readWelcomeOwed(
  groupId: string,
  deps: RecoveryDeps,
  opts: ReAddOptions = {}
): Promise<WelcomeOwedReading | 'no-device-row' | null> {
  try {
    const rows = await deps.mlsService.getDeviceMemberships(
      deps.userId,
      deps.mlsService.getDeviceId()
    );
    // THE READING IS SHARED with the Graine key-group join (`readWelcomeOwedFromRow`), which since
    // 2026-09-27 has the same two doors - an admitter's Welcome, or the device's own external
    // commit.
    const row = rows.find((r) => r.groupId === groupId);
    // NO ROW IS NOT AN `active` ROW, though the shared reading folds both into `not-pending`: an
    // `active` row says this device joined once, no row says nothing about the account at all - the
    // seat of a declined or expired ask, or of a removal, is gone with its device rows. The seam
    // asks the account's seat before choosing a door ({@link readAccountSeat}).
    if (row === undefined) return 'no-device-row';
    const admittedAt =
      row.admittedAtEpoch !== undefined && row.admittedAtEpoch !== null
        ? `at epoch ${row.admittedAtEpoch}`
        : null;
    return classifyOwnSeat(groupId, row, admittedAt, opts.welcomeHandled === true, deps);
  } catch (e) {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... getDeviceMemberships threw: ${String(e).slice(0, 120)}`
    );
    return null;
  }
}

/**
 * Reads THIS DEVICE'S seat ({@link readWelcomeOwedFromRow}) and says what it read - the one place
 * both sources of that seat go through: `getDeviceMemberships`' row, and the account list's
 * `deviceMembership` when the first had none ({@link requestReAdd}). So an anomaly accuses and skips
 * the round whichever source carried it, and a stranded seat is named the same way.
 *
 * @param admittedAt how a commit admitted the seat (`at epoch N`), or null when none did.
 * @returns the reading, or `null` for a `pending` row that does not answer - the caller skips.
 */
function classifyOwnSeat(
  groupId: string,
  row: DeviceMembershipRow,
  admittedAt: string | null,
  readPast: boolean,
  deps: RecoveryDeps
): WelcomeOwedReading | null {
  {
    const reading = readWelcomeOwedFromRow(row, { ignoreQueuedWelcome: readPast });
    if (reading === null) {
      // AN ANOMALY, AND IT ACCUSES: every deployed server writes both facts on a pending row.
      console.error(
        `[READD] ${groupId.slice(0, 8)}... this device's pending row lacks welcomeQueued or addInFlight - the server did not answer the question it always answers`
      );
      return null;
    }
    if (reading === 'awaiting-admission') {
      deps.log(
        `[READD] ${groupId.slice(0, 8)}... invitation-link seat awaiting a member's admission - ` +
          `a member is asked, no self-service join`
      );
    }
    if (reading === 'unhonoured-seat' && admittedAt === null) {
      // NO COMMIT ADMITTED THIS SEAT SINCE IT WAS LAST WRITTEN - which is NOT "never admitted": the
      // server clears `admittedAtEpoch` on every transition, the demotions included (a kick, the
      // stale-device sweep), so a device coming back and one never admitted read the same. Not an
      // anomaly, and not a door by itself: the join decides it on the tree of the GroupInfo it is
      // built on, the one every member's verdict reads (`asAFurtherDevice`).
      deps.log(
        `[READD] ${groupId.slice(0, 8)}... pending seat no commit admitted since it was written - the join's tree decides whose door it is`
      );
      return 'unhonoured-seat';
    }
    if (reading === 'unhonoured-seat') {
      // THIS LINE IS THE DEFECT'S NAME, and it accuses. A roster seat with no Welcome and no Add in
      // flight is the population `reportStrandedDeviceMemberships` names hourly; reaching it here
      // means this device was given a seat nobody ever honoured, and the next lines are the
      // self-service join that used to be unreachable. If it is common, the inviter is dropping
      // devices - which is the P2 next door, not this seam.
      //
      // UNLESS A QUEUED WELCOME WAS READ PAST ON PURPOSE: the caller has just spent one, and the
      // row cannot say whether the Welcome it lists is that one or another. That is not a stranded
      // seat, and saying "NO queued Welcome" of it would be false; the join below is safe either
      // way (`readWelcomeOwedFromRow`). And a seat a commit ADMITTED (`admittedAtEpoch`) is named,
      // because its leaf is already in the tree and the external commit replaces it.
      const admitted =
        admittedAt !== null
          ? ` (a commit admitted this seat ${admittedAt}; the external commit replaces that leaf)`
          : '';
      deps.log(
        readPast && row.welcomeQueued === true
          ? `[READD] ${groupId.slice(0, 8)}... the row still lists a queued Welcome, read past: this device has just spent one for the group` +
              ` - serving ourselves${admitted}`
          : `[READD] ${groupId.slice(0, 8)}... roster seat with NO queued Welcome and NO add in flight` +
              ` - nobody owes us anything; serving ourselves${admitted}`
      );
    }
    return reading;
  }
}

/**
 * Whether THIS ACCOUNT holds a seat in `groupId`, read off the server's list of the account's groups
 * (`GET /mls/users/:id/groups`, the list discovery reads) - asked only when the server holds no row
 * for this device, where the device rows cannot answer it.
 *
 * `unknown` IS NOT A "NO": the list could not be read, or it may not be believed (the guard every
 * destructive reading of absence takes, {@link readGroupSweepSnapshot}). The pass is skipped and the
 * watchdog re-asks on its cadence. Only a believable list without the group says `none`, which ends
 * the recovery on that proof.
 */
async function readAccountSeat(
  groupId: string,
  deps: RecoveryDeps
): Promise<{ kind: 'seated'; row: UserGroupRow } | { kind: 'none' } | { kind: 'unknown' }> {
  const snapshot = await readGroupSweepSnapshot(deps.mlsService, deps.userId, deps.log);
  if (!snapshot.absenceIsEvidence) {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... no row for this device, and whether the account holds a seat ` +
        `could not be read (${snapshot.unusableReason}) - skipping this round`
    );
    return { kind: 'unknown' };
  }
  const row = snapshot.serverGroups.find((g) => g.groupId === groupId);
  return row ? { kind: 'seated', row } : { kind: 'none' };
}

/**
 * Decides a conversation this device was once IN, absent from the account's list, on the group's
 * own answer: ONE reader of the roster ({@link readStillUserMember}) and ONE reducer
 * (`decideAbsentGroupFate`), both shared with discovery, so the two reach the same verdict on the
 * same answer. The group is live (`meta`, read by this pass and not tombstoned), so its roster is
 * the one question left.
 *
 * TERMINATED ON THE PROOF: the roster's typed 403 `NOT_A_MEMBER` is an exclusion, and the row is
 * retired - `active` or `pending` alike. Leaving a `pending` row standing ended this pass but not the
 * next: every conversation is a watchdog candidate and the cooldown had been cleared, so each sweep
 * re-ran the whole pass for ever (re-review of #2493).
 *
 * @returns `proceed` when the roster still names us (the list was stale) and the pass goes on to its
 *   join; `done` when the row was retired, or the roster did not answer and the round is skipped.
 */
async function endOnTheGroupsOwnAnswer(
  groupId: string,
  convo: Conversation,
  meta: GroupMeta,
  deps: RecoveryDeps
): Promise<'proceed' | 'done'> {
  const isStillUserMember = await readStillUserMember(
    deps.mlsService,
    groupId,
    deps.userId,
    deps.log
  );
  const fate = decideAbsentGroupFate({
    lifecycle: convo.lifecycle,
    serverStatus: { kind: 'active', meta },
    isStillUserMember,
  });
  if (fate.action === 'markRemoved') {
    await stopRecovering(groupId, fate.reason, deps);
    return 'done';
  }
  if (isStillUserMember === true) {
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... absent from the account's list, but the group's roster names us - the list was stale; going on`
    );
    return 'proceed';
  }
  deps.log(
    `[READD] ${groupId.slice(0, 8)}... absent from the account's list and the roster unanswered (${fate.reason}) - nothing decided, skipping this round`
  );
  return 'done';
}

/**
 * Asks a reachable member to re-add this device by Welcome, and says WHY it was asked.
 *
 * The single seam for the only remaining way into a group this device cannot join by itself, shared
 * by the two callers that reach it for opposite reasons - one because a link's seat waits for a
 * member's admission, one because the external join was refused. `context` is what keeps the log
 * honest: the same request sent for those two reasons means different things. A Welcome a member
 * already OWES us is never asked for here - it is waited for (`requestReAdd`, DUP-2).
 */
async function askAMemberToReAddUs(
  groupId: string,
  deps: RecoveryDeps,
  context: string
): Promise<void> {
  const short = groupId.slice(0, 8);
  deps.log(`[READD] ${short}... sendWelcomeRequest… (${context})`);
  let answer: WelcomeRequestAnswer;
  try {
    answer = await deps.mlsService.sendWelcomeRequest(groupId);
  } catch (e) {
    deps.log(`[READD] welcome_request failed for ${short}...: ${String(e)}`);
    return;
  }
  // WHAT THE SERVER DID, NOT "SENT": a request that reached nobody used to read exactly like one a
  // member holds. Neither answer is a durable ask - a forwarded one lives on one member's screen, a
  // stored one is drained to a member's screen at its next connection - so the cadence asks again.
  deps.log(
    !answer
      ? `[READD] welcome_request for ${short}... got no answer - nothing is known to be put; asked again on the cadence (${RECOVERY_TIMEOUT_MS / 1000}s)`
      : answer.status === 'stored'
        ? `[READD] welcome_request for ${short}... stored for every member's next connection - no member online`
        : `[READD] welcome_request for ${short}... forwarded to one online member (cadence ${RECOVERY_TIMEOUT_MS / 1000}s)`
  );
}

/**
 * Recovery of a group whose local MLS state is FORKED BEHIND the server
 * (local epoch < server `activeEpoch`), detected via an `epoch_mismatch` commit rejection.
 *
 * Unlike `requestReAdd` alone - which skips groups still present in WASM
 * (cf. `localGroups.includes` guard) - we `forgetGroup` FIRST: the forked group leaves local
 * WASM, then `requestReAdd` rejoins it (external commit, or a welcome_request honored by an
 * up-to-date peer) at the current epoch. History is backfilled by the bundle. Without this forget,
 * the device would keep committing stale epochs that the server rejects in a loop.
 *
 * Write-side analogue (commit rejected) of the read-side epoch-gap escalation
 * (undecipherable message) in `setupMessageHandler`.
 */
export async function recoverForkedGroup(
  groupId: string,
  deps: RecoveryDeps,
  minEpoch = 0
): Promise<void> {
  deps.log(`[FORK] ${groupId.slice(0, 8)}... local state forked behind server - forget + re-add`);
  // minEpoch = known server epoch: rejects a stale re-Welcome from a diverged branch
  // (a commit queued at the old epoch must not re-fork us). Awaited BEFORE the re-add is asked for:
  // this used to checkpoint nothing at all, so a page killed between the two came back holding the
  // fork it had just abandoned, and the re-Welcome it had asked for was then ignored as idempotent.
  await dropGroupState(deps.mlsService, groupId, {
    reason: 'local state forked behind the server',
    minEpoch,
    checkpoint: 'awaited',
    log: deps.log,
  });
  await requestReAdd(groupId, deps);
}

/**
 * Recovery of a group the SERVER refuses this device's frames for, while local WASM still holds a
 * tree for it - the roster and the tree disagree, and the server is the one that is right.
 *
 * THE ONLY SEAM ENTERED ON THE SERVER'S WORD RATHER THAN ON THIS DEVICE'S OWN, which is why it
 * exists at all. Every other entrance infers a desync from a LOCAL absence:
 * `syncConnectionAfterWsOpen` and the SYNC_WATCHDOG both ask `getLocalGroups()`, and
 * `requestReAdd` skips anything that answers yes. That test answers "do I hold a tree", never "does
 * the server accept me as a member", and a device can hold a perfectly well-formed tree for a group
 * whose `dm_device_group_memberships` row has never left `pending`. Such a device is invisible to
 * all three: it looks healthy, it is not, and nothing it encrypts can be opened by anyone.
 *
 * MEASURED ON THE LOCAL ESTATE 2026-09-04, and it is not a corner. A device re-minted after a PIN
 * reset was given a `pending` roster seat at 15:34:52 and never a Welcome. Its outbox held eight
 * messages at attempt 18-23, refused `SenderNotActive` every time and re-queued each as a
 * "transient failure"; the SYNC_WATCHDOG called `cancelReAdd` on the group every 5 s because WASM
 * held it; a full page reload did not lift it. The server names the whole population hourly -
 * `reportStrandedDeviceMemberships`, 70 pending past the window, 25 of them holding a roster seat
 * with no Welcome ever queued, the oldest since 2026-08-27. The report existed; the repair did not.
 *
 * THE FORGET IS WHAT MAKES THE SEAM REACHABLE, and it is what `requestReAdd`'s own guard asks for in
 * as many words ("call forgetGroup before recovery if out of sync"). Dropping the tree costs
 * nothing that was not already worthless - the server holds no leaf for it, so it can neither
 * encrypt for anyone nor be opened by anyone - and it is what lets `requestReAdd` reach the
 * `pending` discriminator written for exactly this population: a member owes us a Welcome, or
 * nobody does and we serve ourselves an external commit. Both were unreachable from here.
 *
 * IT IS THROTTLED ON THE SHARED COOLDOWN AND ARMS NOTHING ITSELF. The outbox re-enters on its own
 * backoff ladder, which starts at 2 s - so an unthrottled forget would discard the tree repeatedly,
 * including a Welcome that had just been processed. The check is read-only here and
 * {@link requestReAdd} still owns the marker, so one attempt per {@link RECOVERY_TIMEOUT_MS} per
 * group holds across every caller, this one included.
 *
 * The checkpoint is NOT optional: without it the forgotten tree is still in IndexedDB, and a reload
 * before the rejoin lands restores the very state this was entered to drop. That is precisely what
 * made the measured device survive a reload still stuck.
 */
export async function recoverRosterDisagreement(
  groupId: string,
  deps: RecoveryDeps
): Promise<void> {
  if (!isReAddDue(groupId)) return;

  deps.log(
    `[ROSTER] ${groupId.slice(0, 8)}... the server refuses our frames while WASM holds the group` +
      ' - forgetting the tree the server has no leaf for, then re-entering recovery'
  );
  if (holdsGroupState(deps.mlsService, groupId)) {
    await dropGroupState(deps.mlsService, groupId, {
      reason: 'the server has no leaf for the tree we hold',
      checkpoint: 'awaited',
      log: deps.log,
    });
  }
  await requestReAdd(groupId, deps);
}

/**
 * Whether `groupId` may be attempted again now, read from the SAME clock {@link requestReAdd}
 * throttles on.
 *
 * **FOR A CALLER THAT DRIVES A CADENCE, AND FOR NO OTHER KIND.** The seam is self-throttling, so
 * invoking it early is harmless - but it is not silent, and a caller that knows the answer should
 * not ask. The SYNC_WATCHDOG polls every five seconds against a sixty-second cooldown: eleven
 * invocations in twelve could only ever return at the throttle, and each one wrote a line saying
 * so. Measured on production 2026-09-12 over a three-and-a-half minute window on an idle tab:
 * **51 `throttled` lines, 5.7% of everything the console held** - for a decision the caller had
 * already made and could have read.
 *
 * A REACTIVE CALLER MUST NOT USE THIS. An unknown group, an `epoch_rejected`, a refused send: those
 * carry new information, they are entitled to ask, and a throttle line on one of them is the
 * report that the information arrived and was too early to act on. Silencing those would hide the
 * rate at which they arrive, which is the opposite of what this function is for.
 *
 * It is a rate limit and therefore a clock, deliberately: what this loop terminates on is a proof
 * (a tombstone, a refused membership, a group nobody can repair), and none of those is here.
 */
export function isReAddDue(groupId: string): boolean {
  return Date.now() - (lastReAddAt.get(groupId) ?? 0) >= RECOVERY_TIMEOUT_MS;
}

/**
 * Clears the recovery cooldown for `groupId`, so a later desync re-triggers immediately instead of
 * waiting out {@link RECOVERY_TIMEOUT_MS}.
 *
 * Called as soon as a Welcome / external join succeeds for this group.
 *
 * IT USED TO TAKE A TIMER MAP, AND NOTHING HAD ARMED ONE SINCE 2026-07-04. The timer existed to
 * schedule the `reboot` step; `reboot` was retired with the CAS/successor machinery, and the only
 * `timers.set` in the codebase went with it - leaving a map that was created, threaded through eight
 * modules, read, cleared and deleted from, and never written. `requestReAdd`'s own doc already said
 * "no private timer".
 */
/**
 * Whether THIS DEVICE has asked to be re-admitted to `groupId` and has not been welcomed back yet.
 *
 * **A RE-ADMISSION IS A REMOVE FOLLOWED BY AN ADD, AND THE REMOVE HALF LOOKS EXACTLY LIKE AN
 * EVICTION.** MLS cannot Welcome a leaf that is still in the tree, so the member answering a
 * `welcome_request` removes us first and adds us back in the next commit. The Remove arrives on its
 * own, names our leaf, and is a signed statement by a member entitled to make it - every test a
 * real exclusion passes. Read as one, it retires the conversation and posts the permanent "you were
 * removed from this group" notice into the thread, seconds before the Welcome makes it false.
 * Observed on a production handset 2026-09-15: `requestReAdd` at 21:37:25, the Remove at 21:37:28,
 * the re-admission Welcome at 21:37:31, and the notice still in the thread hours later.
 *
 * The discriminator was already in hand and nothing read it. `lastReAddAt` is written when this
 * device commits to an attempt and deleted by {@link cancelReAdd} the moment a Welcome or an
 * external join lands, so the ENTRY'S EXISTENCE - not its age - is the durable statement "a
 * re-admission is in flight". The age is the throttle, and that is {@link isReAddDue}'s question,
 * not this one: a clock cannot answer whether the frame in hand is ours, and this must not be
 * decided by one.
 *
 * `false` for a group this device never asked about, which is the shape a real eviction has.
 */
export function reAddIsInFlight(groupId: string): boolean {
  return lastReAddAt.has(groupId);
}

export function cancelReAdd(groupId: string): void {
  lastReAddAt.delete(groupId);
  // A group that just became joinable has no dead end to remember, and leaving one behind would
  // outlive the thing it describes. Every caller of this function reaches it because the group is
  // healthy again - a Welcome landed, an external join succeeded, or WASM already holds the tree.
  noRepairerAt.delete(groupId);
}
