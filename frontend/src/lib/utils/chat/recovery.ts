import type { ExternalJoinOutcome, IMlsService } from '$lib/mls-client/IMlsService';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import type { SvelteMap } from 'svelte/reactivity';
import { persistMlsStateAfterMutation, purgeLocalConversationRecord } from './groupActions';
import { classifyServerStatus } from './groupLifecycle';
import { markGroupNotReady, clearGroupNotReady } from './notReadyRegistry';
import { reconcileGroup } from './historyReconcile';
import { retireConversation } from './conversations';

/**
 * Minimum interval between two recovery attempts for the same not-ready group (throttle + cadence).
 * `requestReAdd` is the single recovery ACTION seam; it self-throttles to one attempt per this
 * interval regardless of how often it is invoked. The SYNC_WATCHDOG (the sole cadence owner)
 * re-invokes it every poll, and reactive paths call it on demand - all funnel through this cooldown.
 * 60s gives FCM iOS (background) time to wake a peer for the welcome_request fallback.
 */
export const RECOVERY_TIMEOUT_MS = 60_000;

/**
 * Per-group timestamp (ms) of the last recovery attempt by {@link requestReAdd}. requestReAdd owns
 * no timer (the SYNC_WATCHDOG owns the cadence); this cooldown is the single throttle that caps
 * every caller - watchdog cadence and reactive triggers alike - to one attempt per
 * {@link RECOVERY_TIMEOUT_MS} per group.
 */
const lastReAddAt = new Map<string, number>();

/**
 * Clears the recovery cooldowns. Called at session setup so a re-login does not inherit a stale
 * throttle that would delay the first recovery attempt of the new session.
 */
export function resetReAddCooldowns(): void {
  lastReAddAt.clear();
}

/**
 * Minimal dependencies required by the recovery functions.
 * Subset of MessageHandlerDeps - the two are compatible.
 */
export interface RecoveryDeps {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
  conversations: SvelteMap<string, Conversation>;
  getSelectedContact: () => string | null;
  setSelectedContact: (id: string | null) => void;
  saveConversation: (key: string) => Promise<void>;
  deleteConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
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
  const entry = [...deps.conversations.entries()].find(([, c]) => c.id === groupId);
  if (entry?.[1].lifecycle === 'removed') return false; // kept until manual local deletion
  const mutated = deps.mlsService.getLocalGroups().includes(groupId);
  if (mutated) deps.mlsService.forgetGroup(groupId);
  if (entry) {
    await purgeLocalConversationRecord({
      conversations: deps.conversations,
      contactKey: entry[0],
      groupId,
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
 */
async function stopRecovering(
  groupId: string,
  reason: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>>
): Promise<void> {
  cancelReAdd(groupId, timers);
  clearGroupNotReady(deps.userId, groupId);
  const convo = deps.conversations.get(groupId);
  if (!convo || convo.lifecycle === 'removed') return;
  deps.log(`[READD] ${groupId.slice(0, 8)}... ${reason} - marking removed`);
  await retireConversation({
    conversations: deps.conversations,
    key: groupId,
    groupId,
    saveConversation: deps.saveConversation,
    patch: { id: groupId },
  });
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
 *  6. Try the self-service external-commit join (Phase 4).
 *  7. The server REFUSED it as a non-member (`NotAGroupMemberError`) -> mark the conversation
 *     removed, stop. This is a terminating ANSWER and not a failed attempt, which is the difference
 *     between this seam terminating on a proof and terminating only when the group gets deleted.
 *  8. Any other failure -> fall back to a single welcome_request (a reachable member re-adds us).
 *     The watchdog re-invokes on its cadence.
 */
export async function requestReAdd(
  groupId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
): Promise<void> {
  // Idempotence: an already-dead conversation does not restart a network recovery.
  const known = deps.conversations.get(groupId);
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
  deps.log(`[READD] ${groupId.slice(0, 8)}... attempt starting`);

  const meta = await deps.mlsService.getGroupMeta(groupId).catch(() => null);
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
      cancelReAdd(groupId, timers);
      clearGroupNotReady(deps.userId, groupId);
      if (await purgePhantomConversation(groupId, deps))
        await persistMlsStateAfterMutation(
          deps.mlsService,
          deps.userId,
          deps.deviceKeyB64,
          deps.log
        );
      return;
    }
    // Transient network error: skip this round, the watchdog retries on its cadence.
  }

  if (deps.mlsService.getLocalGroups().includes(groupId)) {
    clearGroupNotReady(deps.userId, groupId);
    deps.log(
      `[READD] ${groupId.slice(0, 8)}... already in WASM - skip (call forgetGroup before recovery if out of sync)`
    );
    return;
  }

  // Tombstoned server-side: mark the conversation removed, stop recovering.
  if (meta?.deletedAt) {
    await stopRecovering(groupId, 'deleted server-side', deps, timers);
    return;
  }

  // Commit to an attempt: arm the throttle and the persistent not-ready marker (the SYNC_WATCHDOG
  // enumerates it to drive the cadence).
  lastReAddAt.set(groupId, now);
  markGroupNotReady(deps.userId, groupId);

  // Self-service external-commit join first (Phase 4): fetch the stored GroupInfo and rejoin at the
  // current epoch without a peer. On success, clear the recovery bookkeeping and return.
  deps.log(`[READD] ${groupId.slice(0, 8)}... externalJoin…`);
  let outcome: ExternalJoinOutcome;
  try {
    outcome = await deps.mlsService.externalJoin(groupId);
  } catch (e) {
    // A STATUS CODE IS AN ANSWER. The server holds no membership row for us, so there is no base to
    // join and no point asking a member to re-add us - the group's own roster is what refused. This
    // is the proof this loop never had: the refusal used to arrive as a bare `false`, land in the
    // welcome_request fallback below, and come back every minute until the group was deleted.
    if (e instanceof NotAGroupMemberError) {
      await stopRecovering(groupId, 'server holds no membership row for us', deps, timers);
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
  if (outcome.joined) {
    deps.log(`[READD] ${groupId.slice(0, 8)}... rejoined via external commit (self-service)`);
    clearGroupNotReady(deps.userId, groupId);
    cancelReAdd(groupId, timers);
    // External join does not go through the Welcome path that normally promotes the conversation:
    // the group is now live in WASM, so mark it active here so the UI leaves the "syncing" state
    // without waiting for a page reload.
    const convo = deps.conversations.get(groupId);
    if (convo && convo.lifecycle !== 'active') {
      deps.conversations.set(groupId, { ...convo, lifecycle: 'active' });
      await deps.saveConversation(groupId).catch(() => {});
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

  // Fallback: no GroupInfo stored yet -> ask a reachable member to re-add us via a Welcome. The
  // SYNC_WATCHDOG re-invokes this on its cadence until we rejoin. "Or not an authorized member" used
  // to be in this sentence, and it was the bug: that case cannot be answered by any member and now
  // exits at step 7 instead of arriving here.
  //
  // WHAT REACHES HERE IS THEREFORE BOUNDED BY SOMETHING: a group whose base is unpublished has a
  // member who will publish one, or a peer who can send a Welcome. Nothing that reaches this line
  // any longer has a server-side answer proving the request is hopeless.
  deps.log(`[READD] ${groupId.slice(0, 8)}... sendWelcomeRequest…`);
  await deps.mlsService
    .sendWelcomeRequest(groupId)
    .catch((e) =>
      deps.log(`[READD] welcome_request failed for ${groupId.slice(0, 8)}...: ${String(e)}`)
    );
  deps.log(
    `[READD] welcome_request sent for ${groupId.slice(0, 8)}... (fallback, cadence ${RECOVERY_TIMEOUT_MS / 1000}s)`
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
  timers: Map<string, ReturnType<typeof setTimeout>>,
  minEpoch = 0
): Promise<void> {
  deps.log(`[FORK] ${groupId.slice(0, 8)}... local state forked behind server - forget + re-add`);
  // minEpoch = known server epoch: rejects a stale re-Welcome from a diverged branch
  // (a commit queued at the old epoch must not re-fork us).
  deps.mlsService.forgetGroup(groupId, minEpoch);
  await requestReAdd(groupId, deps, timers);
}

/**
 * Cancels any in-flight recovery bookkeeping for `groupId`: clears the recovery cooldown (so a
 * later desync re-triggers immediately) and any residual timer in `timers`.
 *
 * Called as soon as a Welcome / external join succeeds for this group.
 */
export function cancelReAdd(
  groupId: string,
  timers: Map<string, ReturnType<typeof setTimeout>>
): void {
  lastReAddAt.delete(groupId);
  const t = timers.get(groupId);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(groupId);
  }
}
