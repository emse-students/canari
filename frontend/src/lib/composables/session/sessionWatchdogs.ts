/**
 * Session watchdog extracted from useChatSession: startSyncWatchdog (recovery of not-ready groups).
 */
import { SvelteSet } from 'svelte/reactivity';
import { requestReAdd, recoverForkedGroup, cancelReAdd } from '$lib/utils/chat/recovery';
import { clearGroupNotReady, enumerateNotReadyGroups } from '$lib/utils/chat/rebootDeadline';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { getEpochGapSince, clearEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { getIsTabLeader } from '$lib/utils/chat/connection';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';
import { makeRecoveryDeps } from './sessionAuth';

/**
 * Timer-based safety net for a stuck epoch gap. The pipeline's own escalation is REACTIVE
 * (only fires when another undecryptable frame arrives): if a group enters an epoch gap and the
 * peer then goes quiet, no frame escalates and no commit clears it - the group stays local but
 * `isGroupHealthy` reports false, freezing the outbox forever. Past this delay the watchdog
 * forces forget + re-add so sends can resume. Slightly longer than the reactive threshold
 * (EPOCH_GAP_ESCALATION_MS = 30 s) so the reactive path gets first chance.
 */
const STUCK_EPOCH_GAP_MS = 45_000;

/**
 * Starts the universal watchdog (every 5 s), the SINGLE owner of the re-add cadence. It drives
 * recovery for every group lacking local WASM state - both live conversations that lost their
 * state AND groups marked not-ready that have no conversation record yet (a commit arrived before
 * the Welcome, tracked in the persistent `mls_not_ready_since` registry).
 *
 * It routes through the single recovery seam `requestReAdd`, which self-throttles to one
 * welcome_request per RECOVERY_TIMEOUT_MS and escalates to `reboot` past the persistent wall-clock
 * deadline - so invoking it every poll is safe and needs no per-group timer here. Reactive paths
 * (unknown group, out-of-sync) only fire an immediate first attempt; this watchdog owns the rest.
 * Overwrites any previous timer.
 */
export function startSyncWatchdogImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  if (ctx.timers.syncWatchdog !== null) clearInterval(ctx.timers.syncWatchdog);
  ctx.timers.syncWatchdog = setInterval(() => {
    if (!getIsTabLeader()) return;
    const now = Date.now();
    const recoveryDeps = makeRecoveryDeps(ctx, cb);
    const localGroups = new SvelteSet(recoveryDeps.mlsService.getLocalGroups());

    // Union of candidate groups: live conversations + not-ready registry (covers pre-conversation
    // unknown groups). A single set so each group is evaluated once per poll.
    const candidates = new SvelteSet<string>();
    for (const [id] of cb.conversations) candidates.add(id);
    for (const id of enumerateNotReadyGroups(recoveryDeps.userId)) candidates.add(id);

    for (const id of candidates) {
      // WASM has state → group is operational (or Welcome in transit) → no re-add needed.
      // Do NOT test convo.isReady: if isReady=true but WASM lost state during the session,
      // the watchdog must still trigger recovery.
      if (localGroups.has(id)) {
        // Healthy group: clear recovery bookkeeping (cooldown + persistent reboot deadline) so a
        // stale marker cannot trigger an immediate reboot if the group later becomes not-ready.
        clearGroupNotReady(recoveryDeps.userId, id);
        cancelReAdd(id, ctx.connectionRecoveryTimers);

        // Safety net for a stuck epoch gap: the group is in WASM but frozen behind the current
        // epoch, and no incoming frame/commit is coming to escalate or resolve it. Force the
        // forget + re-Welcome so the outbox (gated on !isInEpochGap) unfreezes.
        const gapSince = getEpochGapSince(id);
        if (gapSince !== undefined && now - gapSince > STUCK_EPOCH_GAP_MS) {
          cb.log(
            `[SYNC_WATCHDOG] Group ${id.slice(0, 8)}… epoch gap stuck >${STUCK_EPOCH_GAP_MS / 1000}s - forget + welcome_request`
          );
          clearEpochGap(id);
          recoverForkedGroup(id, recoveryDeps, ctx.connectionRecoveryTimers).catch((e: unknown) =>
            cb.log(`[SYNC_WATCHDOG] gap recovery failed for ${id}: ${String(e)}`)
          );
        }
        continue;
      }
      // Channels utilisent AES-GCM, pas MLS - jamais en recovery MLS.
      if (isChannelConversationId(id)) {
        clearGroupNotReady(recoveryDeps.userId, id);
        continue;
      }
      // Not in WASM → drive the single recovery seam. It marks the group not-ready on the first
      // attempt, throttles to one welcome_request per RECOVERY_TIMEOUT_MS, and reboots past the
      // wall-clock deadline. Calling it every poll is intentional - the seam owns all pacing.
      requestReAdd(id, recoveryDeps, ctx.connectionRecoveryTimers).catch((e: unknown) =>
        cb.log(`[SYNC_WATCHDOG] requestReAdd failed for ${id}: ${String(e)}`)
      );
    }
  }, 5_000);
}
