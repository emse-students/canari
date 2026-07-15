import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { IStorage } from '$lib/db';
import type { Conversation } from '$lib/types';
import type { SvelteMap } from 'svelte/reactivity';
import { persistMlsStateAfterMutation, purgeLocalConversationRecord } from './groupActions';
import { classifyServerStatus } from './groupLifecycle';
import { markGroupNotReady, clearGroupNotReady } from './notReadyRegistry';
import { solicitHistory } from './historySolicit';

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
  pin: string;
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
 *  6. Try the self-service external-commit join (Phase 4); on failure, fall back to a single
 *     welcome_request (a reachable member re-adds us). The watchdog re-invokes on its cadence.
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
  if (now - (lastReAddAt.get(groupId) ?? 0) < RECOVERY_TIMEOUT_MS) return;

  const meta = await deps.mlsService.getGroupMeta(groupId).catch(() => null);

  // No server metadata: `getGroupMeta` returns null for both absent groups and network errors, so
  // resolve the ambiguity - `getGroupServerStatus` distinguishes a CONFIRMED ABSENT (no dm_groups
  // row) from a transient network error.
  if (meta === null) {
    const status = classifyServerStatus(
      await deps.mlsService.getGroupServerStatus(groupId).catch(() => 'error' as const)
    );
    if (status.kind === 'absent') {
      // The group no longer exists AT ALL server-side. Purge the local phantom instead of
      // re-emitting recovery indefinitely for a group that does not exist and is invisible in the UI.
      deps.log(`[READD] ${groupId.slice(0, 8)}... absent from server (confirmed) - phantom purged`);
      cancelReAdd(groupId, timers);
      clearGroupNotReady(deps.userId, groupId);
      if (await purgePhantomConversation(groupId, deps))
        await persistMlsStateAfterMutation(deps.mlsService, deps.userId, deps.pin, deps.log);
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
    clearGroupNotReady(deps.userId, groupId);
    const convo = deps.conversations.get(groupId);
    if (!convo || convo.lifecycle === 'removed') return;
    deps.log(`[READD] ${groupId.slice(0, 8)}... deleted server-side - marking removed`);
    deps.conversations.set(groupId, { ...convo, id: groupId, lifecycle: 'removed' });
    await deps.saveConversation(groupId).catch(() => {});
    return;
  }

  // Commit to an attempt: arm the throttle and the persistent not-ready marker (the SYNC_WATCHDOG
  // enumerates it to drive the cadence).
  lastReAddAt.set(groupId, now);
  markGroupNotReady(deps.userId, groupId);

  // Self-service external-commit join first (Phase 4): fetch the stored GroupInfo and rejoin at the
  // current epoch without a peer. On success, clear the recovery bookkeeping and return.
  if (await deps.mlsService.externalJoin(groupId).catch(() => false)) {
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
    // Solicit the pre-join history from one online member: an external join lands at the current
    // epoch WITHOUT the peer-driven history bundle, so we ask for it explicitly. Bounded,
    // receipt-driven retries rotate past a frozen-online peer; cancelled when the bundle arrives.
    solicitHistory(deps.mlsService, deps.userId, groupId, deps.log);
    return;
  }

  // Fallback: no GroupInfo stored yet (or not an authorized member) -> ask a reachable member to
  // re-add us via a Welcome. The SYNC_WATCHDOG re-invokes this on its cadence until we rejoin.
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
