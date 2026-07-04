import type { IMlsService, UserGroupRow } from '$lib/mls-client/IMlsService';
import type { IStorage } from '$lib/db';
import type { Conversation, ConversationLifecycle } from '$lib/types';
import { persistMlsStateAfterMutation } from '$lib/utils/chat/groupActions';
import type { SvelteMap } from 'svelte/reactivity';
import {
  sendFullHistoryBundle,
  warnSkippedKeyPackages,
  purgeLocalConversationRecord,
} from './groupActions';
import { canonicalDirectName, resolveDirectPeerId } from './conversations';
import { classifyServerStatus } from './groupLifecycle';
import { runExclusiveForGroup } from './groupMutationQueue';
import { resolveTerminalGroup } from './groupSyncEligibility';
import { reassignOutboxConversation } from './outbox';
import { markGroupNotReady, clearGroupNotReady, groupNotReadyForMs } from './rebootDeadline';

/**
 * Minimum interval between two welcome_requests for the same not-ready group (throttle + cadence).
 * `requestReAdd` is the single recovery ACTION seam; it self-throttles to one welcome_request per
 * this interval regardless of how often it is invoked. The SYNC_WATCHDOG (the sole cadence owner)
 * re-invokes it every poll, and reactive paths call it on demand - all funnel through this cooldown.
 * 60s gives FCM iOS (background) time to wake the peer and receive the Welcome.
 */
export const RECOVERY_TIMEOUT_MS = 60_000;

/**
 * PERSISTENT wall-clock deadline before recreating a group (reboot), last resort. Measured
 * from the first instant the group was seen as not-ready (localStorage, survives reload/kill):
 * the counter does not reset on each reconnection. Until reached, we only (re)send
 * welcome_requests - cross-device cooperation recovers the group well before this in the common
 * case. See {@link groupNotReadyForMs}.
 */
export const REBOOT_DEADLINE_MS = 60 * 60_000;

/**
 * Groups with a reboot in progress. Single source of truth shared by all triggers
 * (requestReAdd timer, SYNC_WATCHDOG, checkGroupSuccessors) to guarantee a single reboot
 * pipeline per group at any given time.
 */
const rebootsInFlight = new Set<string>();

/**
 * Per-group timestamp (ms) of the last welcome_request emitted by {@link requestReAdd}. Since
 * requestReAdd no longer arms its own re-add timer (the SYNC_WATCHDOG owns the cadence), this
 * cooldown is the single throttle that caps every caller - watchdog cadence and reactive triggers
 * alike - to one welcome_request per {@link RECOVERY_TIMEOUT_MS} per group.
 */
const lastReAddAt = new Map<string, number>();

/**
 * Clears the recovery cooldowns. Called at session setup so a re-login does not inherit a stale
 * throttle that would delay the first welcome_request of the new session.
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
 * Requests to be re-invited into `groupId` when the local MLS state is absent or out of sync.
 * This is the single recovery ACTION seam (Phase 4 will swap its body for a native external-commit
 * self-join). It performs ONE step per call and self-throttles via {@link RECOVERY_TIMEOUT_MS};
 * the SYNC_WATCHDOG drives the cadence by re-invoking it, and reactive paths call it on demand.
 * There is no private recovery timer.
 *
 * Flow:
 *  1. Conversation already marked dead -> immediate return (idempotent, no network call).
 *  2. Throttled (a welcome_request was emitted for this group < RECOVERY_TIMEOUT_MS ago) -> return.
 *  3. If the group has a successor: `migrateConversation(groupId -> successorId)`; recovery then
 *     continues on the terminal group.
 *  4. Terminal of a successor chain with no server metadata (successor group missing/unreachable)
 *     -> abort without welcome_request or reboot.
 *  5. If the group is deleted without a successor -> mark `deletedRemotely`, abort.
 *  6. Mark the persistent reboot deadline (`markGroupNotReady`), then take ONE escalation step:
 *     `reboot(groupId)` if the persistent wall-clock deadline `REBOOT_DEADLINE_MS` (1 h) is
 *     reached, otherwise (re)send a single `welcome_request`.
 */
export async function requestReAdd(
  groupId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>>
): Promise<void> {
  // Idempotence: an already-dead conversation does not restart a network recovery
  // (avoids re-spamming welcome_request/getGroupMeta on each buffered message from a dead
  // group during a single drain).
  const known = deps.conversations.get(groupId);
  if (known?.lifecycle === 'removed') return;

  // Throttle: this seam is invoked by the watchdog every poll and by reactive paths on demand.
  // Cap it to one attempt per RECOVERY_TIMEOUT_MS per group. The marker is set only once we
  // commit to an attempt (below), so a first call is never blocked. No private timer.
  const now = Date.now();
  if (now - (lastReAddAt.get(groupId) ?? 0) < RECOVERY_TIMEOUT_MS) return;

  const {
    terminalId,
    groupMeta: terminalMeta,
    hasChain,
  } = await resolveTerminalGroup(deps.mlsService, groupId);

  // Group with no server metadata. `terminalMeta=null` is ambiguous (getGroupMeta returns `null`
  // for both absent groups and network errors), so we resolve the ambiguity:
  // `getGroupServerStatus` distinguishes a CONFIRMED ABSENT (no dm_groups row) from a true
  // network error.
  if (terminalMeta === null) {
    const status = classifyServerStatus(
      await deps.mlsService.getGroupServerStatus(terminalId).catch(() => 'error' as const)
    );

    if (status.kind === 'absent') {
      // The group no longer exists AT ALL server-side (neither active nor tombstone: a tombstone
      // would have `deletedAt`, hence non-null metadata). This is a purely local phantom with no
      // server presence. The server is the source of truth -> cut the readd/reboot loop and purge
      // the local residue instead of re-emitting welcome_requests indefinitely for a group that
      // does not exist and is invisible in the UI.
      deps.log(
        `[READD] ${terminalId.slice(0, 8)}... absent from server (confirmed) - phantom purged, recovery stopped`
      );
      cancelReAdd(terminalId, timers);
      cancelReAdd(groupId, timers);
      clearGroupNotReady(deps.userId, terminalId);
      clearGroupNotReady(deps.userId, groupId);
      let purged = await purgePhantomConversation(terminalId, deps);
      if (terminalId !== groupId)
        purged = (await purgePhantomConversation(groupId, deps)) || purged;
      if (purged)
        await persistMlsStateAfterMutation(deps.mlsService, deps.userId, deps.pin, deps.log);
      return;
    }

    // Status not confirmed absent ('unknown' network, or group still exists): ambiguity not
    // resolved. A chain terminal with no metadata would be recreated by a reboot for an
    // unreachable group -> abandon without marking anything (a future successful network sync
    // will re-resolve the chain).
    if (hasChain) {
      deps.log(
        `[READD] terminal ${terminalId.slice(0, 8)}... no server metadata (network) - dead chain, recovery skipped`
      );
      return;
    }
  }

  const localGroups = deps.mlsService.getLocalGroups();

  if (localGroups.includes(terminalId)) {
    clearGroupNotReady(deps.userId, terminalId);
    if (hasChain && groupId !== terminalId && deps.conversations.has(groupId)) {
      deps.log(
        `[READD] ${groupId.slice(0, 8)}... -> terminal ${terminalId.slice(0, 8)}... already in WASM - migrating`
      );
      await migrateConversation(groupId, terminalId, deps).catch(() => {});
    } else {
      deps.log(
        `[READD] ${terminalId.slice(0, 8)}... already in WASM - skip (call forgetGroup before recovery if out of sync)`
      );
    }
    return;
  }

  if (hasChain && groupId !== terminalId) {
    deps.log(`[READD] ${groupId.slice(0, 8)}... -> terminal ${terminalId.slice(0, 8)}...`);
    if (deps.conversations.has(groupId)) {
      await migrateConversation(groupId, terminalId, deps).catch(() => {});
    }
  }

  // Lineage deleted without a usable successor: abort (no reboot possible).
  if (terminalMeta?.deletedAt) {
    clearGroupNotReady(deps.userId, terminalId);
    const convo = deps.conversations.get(terminalId) ?? deps.conversations.get(groupId);
    if (!convo || convo.lifecycle === 'removed') return;
    deps.log(`[READD] ${terminalId.slice(0, 8)}... deleted without successor - aborting`);
    deps.conversations.set(terminalId, {
      ...convo,
      id: terminalId,
      lifecycle: 'removed',
    });
    await deps.saveConversation(terminalId).catch(() => {});
    return;
  }

  // Commit to an attempt: arm the throttle for both the input and the resolved terminal key
  // (one attempt per RECOVERY_TIMEOUT_MS).
  lastReAddAt.set(groupId, now);
  lastReAddAt.set(terminalId, now);

  // Phase 4a: try the self-service external-commit join FIRST - fetch the stored GroupInfo and
  // rejoin at the current epoch without waiting for a peer Welcome. On success, clear the recovery
  // bookkeeping and return. The legacy welcome_request + reboot path below stays as the fallback for
  // when no GroupInfo is available yet (or this device is not an authorized member).
  if (await deps.mlsService.externalJoin(terminalId).catch(() => false)) {
    deps.log(`[READD] ${terminalId.slice(0, 8)}... rejoined via external commit (self-service)`);
    clearGroupNotReady(deps.userId, terminalId);
    cancelReAdd(terminalId, timers);
    return;
  }

  // Fallback: start (or keep) the persistent wall-clock reboot deadline.
  markGroupNotReady(deps.userId, terminalId);

  // One escalation step (folded from the former self-rearming timer). Reboot is the last resort:
  // only once the group has been not-ready for REBOOT_DEADLINE_MS in PERSISTENT real time
  // (survives reload/reconnect). Before that, (re)send a single welcome_request. The SYNC_WATCHDOG
  // re-invokes this every RECOVERY_TIMEOUT_MS; reboot() self-cancels if a Welcome has meanwhile
  // made the group local.
  const notReadyMs = groupNotReadyForMs(deps.userId, terminalId);
  if (notReadyMs !== null && notReadyMs >= REBOOT_DEADLINE_MS) {
    deps.log(
      `[READD] ${terminalId.slice(0, 8)}... not ready for ${Math.round(notReadyMs / 60_000)}min (>=${REBOOT_DEADLINE_MS / 60_000}min) - rebooting`
    );
    await reboot(terminalId, deps, timers).catch((e) =>
      deps.log(`[READD] reboot failed for ${terminalId.slice(0, 8)}...: ${String(e)}`)
    );
  } else {
    await deps.mlsService
      .sendWelcomeRequest(terminalId)
      .catch((e) =>
        deps.log(`[READD] welcome_request failed for ${terminalId.slice(0, 8)}...: ${String(e)}`)
      );
    deps.log(
      `[READD] welcome_request sent for ${terminalId.slice(0, 8)}... (cadence ${RECOVERY_TIMEOUT_MS / 1000}s, reboot after ${REBOOT_DEADLINE_MS / 60_000}min)`
    );
  }
}

/**
 * Recovery of a group whose local MLS state is FORKED BEHIND the server
 * (local epoch < server `activeEpoch`), detected via an `epoch_mismatch` commit rejection.
 *
 * Unlike `requestReAdd` alone - which skips groups still present in WASM
 * (cf. `localGroups.includes` guard) - we `forgetGroup` FIRST: the forked group leaves local
 * WASM, then the emitted welcome_request is honored by an up-to-date peer that re-adds us at
 * the current epoch (the re-Welcome is then no longer ignored as idempotent). History is
 * backfilled by the bundle. Without this forget, the device would keep committing stale epochs
 * that the server rejects in a loop (kick/re-add storm observed in prod).
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
  deps.log(
    `[FORK] ${groupId.slice(0, 8)}... local state forked behind server - forget + welcome_request`
  );
  // minEpoch = known server epoch: rejects a stale re-Welcome from a diverged branch
  // (a commit queued at the old epoch must not re-fork us).
  deps.mlsService.forgetGroup(groupId, minEpoch);
  await requestReAdd(groupId, deps, timers);
}

/**
 * Cancels any in-flight recovery bookkeeping for `groupId`: clears the welcome_request cooldown
 * (so a later desync re-triggers immediately) and any residual legacy timer in `timers`.
 *
 * Called as soon as a Welcome is successfully processed for this group, to prevent a spurious
 * `reboot` from firing when the group has just been joined.
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

/**
 * Resolves an MLS fork (OpenMLS book §fork-resolution) for `groupId`.
 *
 * Full flow:
 *  1. WASM guard: if the group is already local, a late Welcome arrived first -> abort.
 *  2. If a successor already exists (another device won the CAS) -> `joinSuccessor`.
 *  3. If the group is deleted without a successor -> mark `deletedRemotely`, abort.
 *  4. Create a successor candidate S (server + local WASM).
 *  5. CAS `claimGroupSuccessor(G, S)` - first come first served:
 *     - Won: write localStorage key `cas_winner:{G} = S` BEFORE network operations
 *       (crash-safety). If the device crashes between writing the key and the final deletion,
 *       `resumePendingCasBundles` detects the key on next startup and resends the bundle.
 *       The key is removed only after successful send.
 *     - Lost: delete the orphan candidate, join the winner via `joinSuccessor`.
 *  6. Invite all members of G into S (`inviteMembers`).
 *     Important case: if this device never joined G (new device, e.g. A2 after reboot with
 *     no history), its IndexedDB for G is empty -> `sendFullHistoryBundle` will send an empty
 *     bundle. History will be redistributed when a member with data (A1, B) joins S and runs
 *     `joinSuccessor`, which calls `sendFullHistoryBundle` after `migrateConversation`.
 *  7. Migrate the local conversation (G -> S) and send the full history bundle.
 */
export async function reboot(
  groupId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
): Promise<void> {
  const { mlsService, log } = deps;

  // Guard: if the group is already in local WASM, recovery is unnecessary.
  // Protects against races between a late Welcome and reboot timers (requestReAdd, watchdog):
  // without this guard, reboot would create a successor for a functional group.
  if (mlsService.getLocalGroups().includes(groupId)) {
    log(`[REBOOT] ${groupId.slice(0, 8)}... already in WASM - cancelled`);
    return;
  }

  // Intra-device mutual exclusion per group: two concurrent triggers (requestReAdd timer
  // expiring while SYNC_WATCHDOG counts down) each created a successor candidate. The CAS
  // eliminates one, but the loser has already polluted the server and started a pointless
  // joinSuccessor. The lock guarantees a single pipeline per group on this device.
  if (rebootsInFlight.has(groupId)) {
    log(`[REBOOT] ${groupId.slice(0, 8)}... already in progress - ignored`);
    return;
  }
  rebootsInFlight.add(groupId);
  try {
    // Cross-device mutual exclusion: without this Redis lock, two devices detecting the same
    // out-of-sync group each create a candidate before the CAS decides (server pollution with
    // orphan groups). The loser abstains: the winner's successor will be joined via retries
    // (SYNC_WATCHDOG -> requestReAdd, checkGroupSuccessors, or the Welcome received during the
    // winner's inviteMembers). The CAS remains the correction safeguard if the lock expires
    // during reboot.
    const locked = await mlsService.acquireRebootLock(groupId).catch(() => false);
    if (!locked) {
      log(`[REBOOT] ${groupId.slice(0, 8)}... cross-device lock held elsewhere - abstaining`);
      return;
    }
    try {
      await performReboot(groupId, deps, timers);
    } finally {
      await mlsService.releaseRebootLock(groupId).catch(() => {});
    }
  } finally {
    rebootsInFlight.delete(groupId);
  }
}

/**
 * Body of the fork resolution. Always invoked via {@link reboot}, which guarantees
 * per-group mutual exclusion and the "already present in WASM" guard.
 */
async function performReboot(
  groupId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>>
): Promise<void> {
  const { mlsService, userId, pin, log } = deps;

  log(`[REBOOT] Starting for group ${groupId.slice(0, 8)}...`);

  // Step 1: server status of the group (successor already claimed? deleted?).
  // We distinguish CONFIRMED absence from network uncertainty: a `getGroupMeta` returning
  // `null` on a simple network blip (indistinguishable from a 404) would miss an existing
  // `successorId` and push us to create a DUPLICATE successor (server pollution + fork). On
  // network doubt (`unknown`), defer the reboot - the next tick will retry.
  const status = classifyServerStatus(await mlsService.getGroupServerStatus(groupId));
  if (status.kind === 'unknown') {
    log(`[REBOOT] ${groupId.slice(0, 8)}... server status uncertain (network) - deferring`);
    return;
  }
  const meta = status.kind === 'absent' ? null : status.meta;
  if (meta?.successorId) {
    return joinSuccessor(groupId, meta.successorId, deps, timers);
  }

  // Group deleted without successor: the CAS claimSuccessor will always fail
  // ("deletedAt IS NULL" condition not satisfied), creating an orphan candidate each attempt.
  // Same abort as requestReAdd - mark the conversation removed.
  if (meta?.deletedAt && !meta.successorId) {
    log(`[REBOOT] ${groupId.slice(0, 8)}... deleted without successor - aborting`);
    const convo = deps.conversations.get(groupId);
    if (convo && convo.lifecycle !== 'removed') {
      deps.conversations.set(groupId, { ...convo, lifecycle: 'removed' });
      await deps.saveConversation(groupId).catch(() => {});
    }
    return;
  }

  // Step 2: read group info from the server (name, isGroup)
  let groups: UserGroupRow[];
  try {
    groups = await mlsService.getUserGroups(userId);
  } catch {
    groups = [];
  }
  const row = groups.find((g) => g.groupId === groupId);
  const isGroup = row?.isGroup ?? meta?.isGroup ?? false;
  let name = row?.name ?? meta?.name ?? '';

  // For a DM, never propagate a possibly-malformed ancestor name (a self-only name would make
  // the successor look like a "conversation with yourself"). Recompute the canonical self::peer
  // from the repaired conversation's peer, falling back to the ancestor's authoritative roster.
  if (!isGroup) {
    const self = userId.toLowerCase();
    const convo = [...deps.conversations.values()].find((c) => c.id === groupId);
    const knownPeer = (convo?.directPeerId ?? '').toLowerCase();
    let peer = knownPeer && knownPeer !== self ? knownPeer : null;
    if (!peer) peer = await resolveDirectPeerId(mlsService, groupId, name, userId, log);
    if (peer) name = canonicalDirectName(userId, peer);
    else log(`[REBOOT] ${groupId.slice(0, 8)}... DM peer unresolved - keeping name "${name}"`);
  }

  // Step 3: create a successor candidate
  let candidateId: string | null = null;
  try {
    candidateId = await mlsService.createRemoteGroup(name, isGroup);
    log(`[REBOOT] Candidate created: ${candidateId.slice(0, 8)}...`);
    await mlsService.createGroup(candidateId);
    await mlsService.registerMember(candidateId, userId);
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);
  } catch (e) {
    log(`[REBOOT] Candidate creation failed: ${String(e)}`);
    if (candidateId) {
      await mlsService.deleteGroupOnServer(candidateId).catch(() => {});
      mlsService.forgetGroup(candidateId);
    }
    throw e;
  }

  // Second look anti-false-positive: candidate creation (step 3) chained several network
  // round-trips; a late Welcome may have joined the original group in the meantime.
  // The following CAS soft-deletes the original IRREVERSIBLY - abstain and discard the orphan
  // candidate if the group became healthy in local WASM again.
  if (mlsService.getLocalGroups().includes(groupId)) {
    log(
      `[REBOOT] ${groupId.slice(0, 8)}... back in WASM before CAS - candidate ${candidateId.slice(0, 8)}... cancelled`
    );
    await mlsService.deleteGroupOnServer(candidateId).catch(() => {});
    mlsService.forgetGroup(candidateId);
    return;
  }

  // Step 4: CAS - first come first served.
  // We pass the current device to attribute the reboot (server-side diagnostics).
  const claim = await mlsService.claimGroupSuccessor(
    groupId,
    candidateId,
    mlsService.getDeviceId()
  );

  if (!claim.claimed) {
    // CAS lost - clean up the orphan candidate and join the winner
    log(
      `[REBOOT] CAS lost - deleting ${candidateId.slice(0, 8)}..., migrating to ${claim.successorId?.slice(0, 8)}...`
    );
    await mlsService.deleteGroupOnServer(candidateId).catch(() => {});
    mlsService.forgetGroup(candidateId);
    if (claim.successorId) return joinSuccessor(groupId, claim.successorId, deps, timers);
    return;
  }

  // Step 5: CAS won - mark this device as responsible for the history bundle
  // before any network operation to survive crashes.
  const casBundleKey = `cas_winner:${groupId}`;
  localStorage.setItem(casBundleKey, candidateId);

  // Clear the pending_welcome queue of the old group: welcome_requests stored
  // while peers were unavailable must no longer be re-delivered now that the successor
  // is ready.
  await mlsService
    .clearPendingWelcomeRequests(groupId)
    .catch((e) => log(`[REBOOT] Error clearing pending welcome_requests: ${String(e)}`));

  // Invite all members of the old group.
  // If the dead group has no more members (deleteGroup cleared dm_group_members),
  // walk up the chain to find the closest ancestor that still has members.
  log(`[REBOOT] CAS won - inviting members into ${candidateId.slice(0, 8)}...`);
  const memberSourceId = await findAncestorWithMembers(groupId, groups, deps);
  await inviteMembers(memberSourceId, candidateId, deps).catch((e) =>
    log(`[REBOOT] Error inviting members: ${String(e)}`)
  );

  // Step 6: migrate the local conversation (copy ALL messages from G to S)
  await migrateConversation(groupId, candidateId, deps);

  // Mark the successor as ready (this device is the creator)
  const newConvo = deps.conversations.get(candidateId);
  if (newConvo && newConvo.lifecycle !== 'active') {
    deps.conversations.set(candidateId, { ...newConvo, lifecycle: 'active' });
    await deps.saveConversation(candidateId).catch(() => {});
  }

  // Step 7: send full history to invited members (population 3 - fresh devices).
  // Called after migrateConversation: G's messages are now in S.
  await sendFullHistoryBundle(candidateId, {
    storage: deps.storage,
    pin: deps.pin,
    mlsService: deps.mlsService,
    log: deps.log,
  }).catch((e) => log(`[REBOOT] History bundle error: ${String(e)}`));
  localStorage.removeItem(casBundleKey);

  log(`[REBOOT] Done: ${groupId.slice(0, 8)}... -> ${candidateId.slice(0, 8)}...`);
}

/**
 * Joins the successor already claimed by another device and redistributes the history.
 *
 * Flow:
 *  1. Register this device as a member of the successor server-side.
 *  2. If the successor is not yet in local WASM (Welcome not yet received), call
 *     `requestReAdd(successorId)`: sends a welcome_request and arms a 60s timer ->
 *     reboot(successorId). The timer is harmless if the group is joined before expiry
 *     (`localGroups.includes` guard in `reboot`).
 *  3. `migrateConversation`: copy messages from G to S in local IndexedDB and merge
 *     conversations in memory.
 *  4. `sendFullHistoryBundle`: redistribute the freshly migrated history from G to active
 *     members of S.
 *
 * Step 4 is essential to cover the case where the successor creator (A2) had no history
 * at reboot time (new device) and therefore sent an empty bundle. Now that our IndexedDB
 * for S contains G's messages, we make them available to A2 and other members who have not
 * yet received the full bundle.
 */
async function joinSuccessor(
  deadGroupId: string,
  successorId: string,
  deps: RecoveryDeps,
  timers: Map<string, ReturnType<typeof setTimeout>>
): Promise<void> {
  const { mlsService, userId, log } = deps;
  log(`[REBOOT] Joining successor ${successorId.slice(0, 8)}...`);

  await mlsService.registerMember(successorId, userId).catch(() => {});

  if (!mlsService.getLocalGroups().includes(successorId)) {
    await requestReAdd(successorId, deps, timers);
  }

  await migrateConversation(deadGroupId, successorId, deps);

  // Redistribute the migrated history to active members of the successor.
  await sendFullHistoryBundle(successorId, {
    storage: deps.storage,
    pin: deps.pin,
    mlsService: deps.mlsService,
    log: deps.log,
  }).catch((e) => log(`[JOIN_SUCCESSOR] History bundle error: ${String(e)}`));
}

/**
 * Walks the succession chain backwards from `groupId` to find the most recent group
 * that still has entries in `dm_group_members` (user-level, stable across device changes).
 *
 * The most recent version (`groupId`) is checked first: it is the most up-to-date source of
 * group composition. We only walk up to an ancestor if `groupId` itself was explicitly
 * deleted via `deleteGroupOnServer` (which clears dm_group_members), which is rare and
 * distinct from the normal reboot flow.
 * Returns `groupId` if no ancestor has members either.
 */
async function findAncestorWithMembers(
  groupId: string,
  chainGroups: UserGroupRow[],
  deps: RecoveryDeps
): Promise<string> {
  // Prioritize the current group: dm_group_members (user-level) is stable and reflects
  // the most recent composition, independent of device changes.
  const userMembers = await deps.mlsService.getGroupUserMembers(groupId).catch(() => []);
  if (userMembers.length > 0) return groupId;

  let current = groupId;
  for (let depth = 0; depth < 10; depth++) {
    const parent = chainGroups.find((g) => g.successorId === current);
    if (!parent) break;
    const parentUserMembers = await deps.mlsService
      .getGroupUserMembers(parent.groupId)
      .catch(() => []);
    if (parentUserMembers.length > 0) {
      deps.log(
        `[REBOOT] dm_group_members absent for ${groupId.slice(0, 8)}... - fallback ancestor ${parent.groupId.slice(0, 8)}...`
      );
      return parent.groupId;
    }
    current = parent.groupId;
  }
  return groupId;
}

/**
 * Invites all members of `deadGroupId` into the new successor group.
 *
 * Sources to determine who to invite (by priority):
 *  1. `getGroupMembers` (dm_device_group_memberships, active) - primary source.
 *  2. `getGroupUserMembers` (dm_group_members, user-level) - fallback if source 1 is empty
 *     (typical case: creator device removed via fresh-start, which clears device-level
 *     entries but leaves dm_group_members intact).
 *
 * For each userId found, fetch current devices via `fetchUserDevices`, add them bulk to
 * `successorId` (WASM + server), then send commit -> Welcomes -> register non-creator
 * members in dm_group_members (without this, getUserGroups won't return the successor
 * for them).
 */
async function inviteMembers(
  deadGroupId: string,
  successorId: string,
  deps: RecoveryDeps
): Promise<void> {
  const { mlsService, userId, pin, log } = deps;

  const members = await mlsService.getGroupMembers(deadGroupId);
  // Include ALL userIds (including the creator) to invite their other devices.
  // Only exclude the current device itself (already in the group as creator).
  const myDeviceId = mlsService.getDeviceId();
  let allUserIds = [...new Set(members.map((m) => m.userId))];
  if (allUserIds.length === 0) {
    // dm_device_group_memberships empty (e.g. creator device removed via fresh-start).
    // Fallback to dm_group_members (user-level, stable): source of truth for membership.
    // Strict (no `.catch`): a network error here surfaces to the caller's `.catch` log
    // (reboot 466 / health 905) rather than being confused with an empty group (audit S2) -
    // the health-check epoch=0 net will re-invite once the network recovers.
    const userMembers = await mlsService.getGroupUserMembers(deadGroupId);
    allUserIds = [...new Set(userMembers.map((m) => m.userId))];
    if (allUserIds.length > 0) {
      log(
        `[REBOOT] Fallback dm_group_members: ${allUserIds.map((u) => u.slice(0, 8)).join(', ')}...`
      );
    }
  }
  if (allUserIds.length === 0) {
    log('[REBOOT] No members in the dead group.');
    return;
  }

  // Fetch devices of all members in parallel
  const devicesByUser = await Promise.all(allUserIds.map((id) => mlsService.fetchUserDevices(id)));
  const allDevices: Array<{ keyPackage: Uint8Array; deviceId: string }> = [];
  const deviceToUser = new Map<string, string>();
  for (const [i, devices] of devicesByUser.entries()) {
    for (const d of devices) {
      if (d.deviceId === myDeviceId) continue; // Skip the current device (creator)
      allDevices.push(d);
      deviceToUser.set(d.deviceId, allUserIds[i]);
    }
  }
  if (allDevices.length === 0) {
    log('[REBOOT] No other device available (current device is the only one).');
    return;
  }

  // Acquire the add-lock - retry once after 2s (fix R5)
  let locked = await mlsService.acquireAddLock(successorId).catch(() => false);
  if (!locked) {
    await new Promise((r) => setTimeout(r, 2_000));
    locked = await mlsService.acquireAddLock(successorId).catch(() => false);
    if (!locked) {
      log('[REBOOT] Add-lock unavailable - aborting (another device is handling it).');
      return;
    }
  }

  try {
    // Staged transaction (C7-A): addMembersBulk stages the Add, validates the epoch server-side,
    // merges on accept and broadcasts the commit (fix R4: epoch-validated), or rolls back on reject.
    const bulk = await mlsService.addMembersBulk(successorId, allDevices);
    log(`[REBOOT] ${bulk.addedDeviceIds.length} device(s) added`);
    warnSkippedKeyPackages(bulk.skippedDeviceIds, successorId, '[REBOOT]', log);

    // Persist after the merged commit (on crash, members can rejoin via welcome_request).
    await persistMlsStateAfterMutation(mlsService, userId, pin, log);

    // Then the Welcomes
    if (bulk.welcome) {
      for (const deviceId of bulk.addedDeviceIds) {
        const memberId = deviceToUser.get(deviceId);
        if (!memberId) continue;
        await mlsService
          .sendWelcome(bulk.welcome, memberId, successorId, deviceId, bulk.ratchetTree)
          .catch((e) => log(`[REBOOT] Welcome error ${deviceId}: ${String(e)}`));
        log(`[REBOOT] Welcome sent to ${memberId}:${deviceId}`);
      }
    }

    // Register invited userIds (who are not the creator) in dm_group_members.
    // sendWelcome updates dm_device_group_memberships (device-level) but not
    // dm_group_members (user-level). Without this, getUserGroups won't return the successor
    // for other members, who would never know to join it.
    const addedUserIds = new Set<string>();
    for (const deviceId of bulk.addedDeviceIds) {
      const uid = deviceToUser.get(deviceId);
      if (uid && uid !== userId) addedUserIds.add(uid);
    }
    for (const uid of addedUserIds) {
      await mlsService
        .registerMember(successorId, uid)
        .catch((e) => log(`[REBOOT] registerMember ${uid.slice(0, 8)}...: ${String(e)}`));
    }
  } finally {
    await mlsService.releaseAddLock(successorId).catch(() => {});
  }
}

/**
 * Migrates a conversation from the old group to the successor:
 * - Copies local messages (with deduplication - fix C8)
 * - Updates the conversation in the reactive map
 * - Redirects the UI if the active conversation was the old one
 * - Deletes the old entry
 */
export async function migrateConversation(
  fromGroupId: string,
  toGroupId: string,
  deps: RecoveryDeps
): Promise<void> {
  // H3: serialize per successor group. Without this, a Welcome (upsertConversation) and a tick
  // (checkGroupSuccessors) targeting the same successor interleave around `await` and
  // overwrite each other (double migration / in-memory messages lost).
  return runExclusiveForGroup(toGroupId, () =>
    migrateConversationLocked(fromGroupId, toGroupId, deps)
  );
}

/** Body of {@link migrateConversation}, always executed under the per-group lock (H3). */
async function migrateConversationLocked(
  fromGroupId: string,
  toGroupId: string,
  deps: RecoveryDeps
): Promise<void> {
  const {
    storage,
    conversations,
    pin,
    getSelectedContact,
    setSelectedContact,
    saveConversation,
    deleteConversation,
    log,
  } = deps;

  const oldConvo = conversations.get(fromGroupId);
  if (!oldConvo) {
    log(`[MIGRATE] Source conversation ${fromGroupId.slice(0, 8)}... not found - skip`);
    return;
  }
  log(`[MIGRATE] ${fromGroupId.slice(0, 8)}… → ${toGroupId.slice(0, 8)}… ("${oldConvo.name}")`);

  const existingTarget = conversations.get(toGroupId);
  const localGroups = deps.mlsService.getLocalGroups();
  const targetAlreadyReady =
    existingTarget?.lifecycle === 'active' || localGroups.includes(toGroupId);
  const targetLifecycle: ConversationLifecycle = targetAlreadyReady ? 'active' : 'pending';

  // Always copy messages - saveMessages is an upsert (idempotent by id).
  // A second call returns 0 results because the old conversationId no longer exists.
  // The previous !existingTarget guard caused message loss on population 2 devices
  // (Welcome received -> S in conversations, but G's messages not migrated).
  //
  // messagesCopied = true if the copy succeeded (or there was nothing to copy).
  // If false, the source is kept in IndexedDB to avoid any message loss.
  let messagesCopied = false;
  if (storage) {
    try {
      const msgs = await storage.getMessages(fromGroupId, pin);
      if (msgs.length > 0) {
        const rekeyed = msgs.map((m) => ({ ...m, conversationId: toGroupId }));
        await storage.saveMessages(rekeyed, pin);
        log(`[MIGRATE] ${msgs.length} message(s) copied`);
      }
      messagesCopied = true;
    } catch (e) {
      log(`[MIGRATE] Message copy error: ${String(e)} - source kept in DB`);
    }
  } else {
    messagesCopied = true; // no storage: nothing to protect
  }

  // Outbox: re-key pending messages fromGroup -> toGroup so they go out in the successor
  // (resolve-at-flush already covers this; the re-key keeps the persistent state consistent
  // and triggers a flush toward the new group).
  await reassignOutboxConversation(fromGroupId, toGroupId).catch(() => {});

  // Persist the new conversation before deleting the old one
  if (storage) {
    await storage
      .saveConversation({
        id: toGroupId,
        name: oldConvo.name,
        lifecycle: targetLifecycle,
        updatedAt: Date.now(),
      })
      .catch((e) => log(`[MIGRATE] Save error: ${String(e)}`));
  }

  // Merge messages in memory: old (fromGroup) first, then any new ones that arrived in
  // toGroup since the Welcome, deduplicated by id.
  // Without this merge, if upsertConversation already created toGroup empty before
  // migrateConversation runs (timing handleWelcome -> checkGroupSuccessors), the existingTarget
  // spread keeps messages=[] and the old ones are invisible until next reload (they are in
  // IndexedDB but not in memory).
  const seen = new Set<string>();
  const mergedMessages = [...(oldConvo.messages ?? []), ...(existingTarget?.messages ?? [])].filter(
    (m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    }
  );

  const merged: Conversation = existingTarget
    ? {
        ...existingTarget,
        name: oldConvo.name,
        lifecycle: targetLifecycle,
        messages: mergedMessages,
      }
    : { ...oldConvo, id: toGroupId, lifecycle: targetLifecycle };
  conversations.set(toGroupId, merged);

  if (getSelectedContact() === fromGroupId) setSelectedContact(toGroupId);

  // Only delete the source from IndexedDB if messages were successfully copied.
  // If the copy failed, the source stays in DB and checkGroupSuccessors will retry the migration.
  conversations.delete(fromGroupId);
  if (messagesCopied) {
    if (deleteConversation) await deleteConversation(fromGroupId).catch(() => {});
  } else {
    log(`[MIGRATE] Source ${fromGroupId.slice(0, 8)}... kept in DB (messages not migrated)`);
  }

  // H2: do NOT forget the predecessor until the successor is TRULY in WASM.
  // Otherwise, incoming messages for the predecessor fall into handleUnknownGroup -> welcome_request
  // loop until the successor arrives. Keep it decryptable; a future checkGroupSuccessors /
  // joinSuccessor will redo the migration once S is joined.
  if (deps.mlsService.getLocalGroups().includes(toGroupId)) {
    try {
      deps.mlsService.forgetGroup(fromGroupId);
    } catch {
      /* non-blocking */
    }
  } else {
    log(
      `[MIGRATE] Successor ${toGroupId.slice(0, 8)}... not yet in WASM - predecessor ${fromGroupId.slice(0, 8)}... kept (H2)`
    );
  }

  await saveConversation(toGroupId);
  log(`[MIGRATE] Done - "${oldConvo.name}" now lives in ${toGroupId.slice(0, 8)}...`);
}

/**
 * Synchronises group successions detected server-side.
 *
 * Called once on connection, then every 5 minutes (leader tab only).
 *
 * For each server group that has a successor:
 *
 *  A) Local migration (if G is in conversations but S is not):
 *     Copy messages from G to S in IndexedDB and update the reactive Map.
 *
 *  B) Crash-safety - bundle not yet sent (Gap 2):
 *     If `localStorage["cas_winner:{G}"] === S` and S is in local WASM with epoch > 0,
 *     this device won the CAS, finished inviting members, but crashed before sending the
 *     history bundle. The bundle is resent here, then the key is deleted.
 *     The `cas_winner:{G}` key is written by `reboot()` BEFORE network operations and
 *     deleted only after success - it survives crashes and restarts.
 *
 *  C) Crash-safety - incomplete invitation (epoch = 0):
 *     If S is in WASM but at epoch 0, the device created S but crashed before
 *     `inviteMembers`. The invitation and bundle are restarted here.
 *
 * Note: the scenario "device with no history initiates a reboot, sends an empty bundle"
 * (e.g. A2 new device) is covered by `joinSuccessor` - when a member with data (A1) joins
 * S later, it redistributes `sendFullHistoryBundle` after `migrateConversation`.
 */
export async function checkGroupSuccessors(deps: RecoveryDeps): Promise<void> {
  const { mlsService, userId, pin, conversations, log } = deps;

  let serverGroups: UserGroupRow[];
  try {
    serverGroups = await mlsService.getUserGroups(userId);
  } catch {
    return;
  }

  for (const g of serverGroups) {
    if (!g.successorId) continue;
    const successorId = g.successorId;

    // localStorage key indicating whether this device still needs to send the full bundle.
    // Written in reboot() before inviteMembers to survive crashes.
    const casBundleKey = `cas_winner:${g.groupId}`;

    // Migration if not yet done (population 1 CAS winner after crash, or device that
    // had G but does not yet have S in conversations).
    if (conversations.has(g.groupId) && !conversations.has(successorId)) {
      log(
        `[HEALTH] Successor detected ${g.groupId.slice(0, 8)}... -> ${successorId.slice(0, 8)}... - migrating`
      );
      await migrateConversation(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Migration error: ${String(e)}`)
      );
    } else if (conversations.has(g.groupId)) {
      // Population 2: both G and S are in conversations (Welcome received before
      // checkGroupSuccessors). migrateConversation now copies messages in all cases
      // (guard !existingTarget removed) then deletes G.
      log(
        `[HEALTH] Migrating messages ${g.groupId.slice(0, 8)}... -> ${successorId.slice(0, 8)}... (both present)`
      );
      await migrateConversation(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Migration error: ${String(e)}`)
      );
      try {
        await persistMlsStateAfterMutation(mlsService, userId, pin, log);
      } catch {
        /* non-blocking */
      }
    }

    // Resilience: full bundle not yet sent (crash between migrateConversation and
    // sendFullHistoryBundle in reboot, or checkGroupSuccessors restarted the migration).
    const localGroups = mlsService.getLocalGroups();
    if (
      localStorage.getItem(casBundleKey) === successorId &&
      localGroups.includes(successorId) &&
      mlsService.getEpoch(successorId) > 0
    ) {
      log(`[HEALTH] Retrying full history bundle -> ${successorId.slice(0, 8)}...`);
      await sendFullHistoryBundle(successorId, {
        storage: deps.storage,
        pin,
        mlsService,
        log,
      }).catch((e) => log(`[HEALTH] Retry bundle error: ${String(e)}`));
      localStorage.removeItem(casBundleKey);
    }

    // Crash recovery: this device won the CAS but did not invite members (epoch=0)
    if (localGroups.includes(successorId) && mlsService.getEpoch(successorId) === 0) {
      log(`[HEALTH] Successor ${successorId.slice(0, 8)}... epoch=0 - post-crash re-invitation`);
      await inviteMembers(g.groupId, successorId, deps).catch((e) =>
        log(`[HEALTH] Re-invitation error: ${String(e)}`)
      );
      const convo = conversations.get(successorId);
      if (convo && convo.lifecycle !== 'active') {
        conversations.set(successorId, { ...convo, lifecycle: 'active' });
        await deps.saveConversation(successorId).catch(() => {});
      }
      // Send the bundle after the invitation (epoch is now > 0 after addMembers)
      await sendFullHistoryBundle(successorId, {
        storage: deps.storage,
        pin,
        mlsService,
        log,
      }).catch((e) => log(`[HEALTH] Post-crash-invite bundle error: ${String(e)}`));
      localStorage.removeItem(casBundleKey);
    }
  }
}
