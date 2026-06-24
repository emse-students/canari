/**
 * Session watchdogs extracted from useChatSession:
 * startHealthCheck (successor migration), startSyncWatchdog (reboot of stuck groups).
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { checkGroupSuccessors, requestReAdd, RECOVERY_TIMEOUT_MS } from '$lib/utils/chat/recovery';
import { clearGroupNotReady } from '$lib/utils/chat/rebootDeadline';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { getIsTabLeader } from '$lib/utils/chat/connection';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';
import { makeRecoveryDeps } from './sessionAuth';

/**
 * Starts the periodic health check (every 5 min) that migrates groups
 * whose successor has been claimed by another device.
 * Also runs an immediate check on startup. Overwrites any previous timer.
 */
export function startHealthCheckImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  const recoveryDeps = makeRecoveryDeps(ctx, cb);

  checkGroupSuccessors(recoveryDeps).catch((e) =>
    cb.log(`[HEALTH] Initial health check error: ${e instanceof Error ? e.message : String(e)}`)
  );

  if (ctx.timers.health !== null) clearInterval(ctx.timers.health);
  ctx.timers.health = setInterval(
    () => {
      if (!getIsTabLeader()) return;
      checkGroupSuccessors(recoveryDeps).catch((e) =>
        cb.log(`[HEALTH] Health check error: ${e instanceof Error ? e.message : String(e)}`)
      );
    },
    5 * 60 * 1_000
  );
}

/**
 * Starts the universal watchdog (every 5 s) that re-triggers recovery for any group
 * that has been not-ready (no local WASM state) for longer than RECOVERY_TIMEOUT_MS.
 * Covers all desync paths regardless of whether an individual timer was armed.
 *
 * Routes through `requestReAdd` (welcome_request first, escalating to reboot via the
 * shared `connectionRecoveryTimers`) rather than calling `reboot()` directly: orphaned
 * groups get a Welcome grace window before the irreversible CAS, and `requestReAdd`
 * also resolves the lineage (migration to the terminal already present in WASM).
 * Overwrites any previous timer.
 */
export function startSyncWatchdogImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  /** Timestamp (ms) when each group was first detected as not-ready. */
  const notReadySince = new SvelteMap<string, number>();

  if (ctx.timers.syncWatchdog !== null) clearInterval(ctx.timers.syncWatchdog);
  ctx.timers.syncWatchdog = setInterval(() => {
    if (!getIsTabLeader()) return;
    const now = Date.now();
    const recoveryDeps = makeRecoveryDeps(ctx, cb);
    const localGroups = new SvelteSet(recoveryDeps.mlsService.getLocalGroups());

    for (const [id] of cb.conversations) {
      // WASM has state → group is operational (or Welcome in transit) → no recovery needed.
      // Do NOT test convo.isReady: if isReady=true but WASM lost state during the session,
      // the watchdog must still trigger recovery.
      if (localGroups.has(id)) {
        notReadySince.delete(id);
        // Healthy group: clear the persistent reboot deadline (prevents a stale key from
        // triggering an immediate reboot if the group later becomes not-ready again).
        clearGroupNotReady(recoveryDeps.userId, id);
        continue;
      }
      // Channels utilisent AES-GCM, pas MLS - jamais en recovery MLS.
      if (isChannelConversationId(id)) {
        notReadySince.delete(id);
        continue;
      }
      const since = notReadySince.get(id);
      if (since === undefined) {
        notReadySince.set(id, now);
      } else if (now - since > RECOVERY_TIMEOUT_MS) {
        // Reset the 60 s window rather than using a permanent flag: if recovery fails
        // silently (e.g. cross-device lock winner crashes mid-reboot), the group will be
        // retried on the next 60 s cycle instead of staying stuck. Concurrent reboots are
        // already blocked upstream (rebootsInFlight intra-device + Redis cross-device lock
        // in reboot()), and requestReAdd deduplicates its own timer - re-triggering only
        // produces one welcome_request per 60 s, not a storm.
        notReadySince.set(id, now);
        cb.log(
          `[SYNC_WATCHDOG] Group ${id.slice(0, 8)}… not ready for >${RECOVERY_TIMEOUT_MS / 1000}s - welcome_request + reboot escalation`
        );
        requestReAdd(id, recoveryDeps, ctx.connectionRecoveryTimers).catch((e: unknown) =>
          cb.log(`[SYNC_WATCHDOG] requestReAdd failed for ${id}: ${String(e)}`)
        );
      }
    }
  }, 5_000);
}
