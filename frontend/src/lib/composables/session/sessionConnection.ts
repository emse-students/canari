/**
 * WebSocket connection management functions extracted from useChatSession:
 * scheduleReconnect, attemptReconnect, pauseConnection, resumeConnection,
 * startConnectionWatchdog, stopConnectionWatchdog, runGroupDiscovery.
 */
import { goto } from '$app/navigation';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { discoverMissingGroups } from '$lib/utils/chat/actions';
import {
  openGatewayConnection,
  syncConnectionAfterWsOpen,
  getIsTabLeader,
} from '$lib/utils/chat/connection';
import { requestReAdd, RECOVERY_TIMEOUT_MS } from '$lib/utils/chat/recovery';
import { markConversationDeletedRemotely } from '$lib/utils/chat/conversations';
import type { IMlsService } from '$lib/mlsService';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';
import { makeRecoveryDeps, processDeviceInvitationsLocally } from './sessionAuth';
import { startSyncWatchdogImpl } from './sessionWatchdogs';

/** Connection watchdog duration - same value as RECOVERY_TIMEOUT_MS. */
const CONNECTION_WATCHDOG_MS = RECOVERY_TIMEOUT_MS;

/**
 * Fires `discoverMissingGroups` and logs any error.
 * Centralises the 7-field spread to avoid duplication across every call site.
 */
export function runGroupDiscoveryImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  mlsService: IMlsService,
  label = ''
): void {
  const st = ctx.getStorage();
  discoverMissingGroups({
    mlsService,
    userId: ctx.getUserId(),
    deviceKeyB64: ctx.getDeviceKey(),
    conversations: cb.conversations,
    saveConversation: cb.saveConversation,
    deleteConversation: st ? (id) => st.deleteConversation(id) : undefined,
    log: cb.log,
    storage: st,
  }).catch((e) =>
    cb.log(
      `[WARN] Echec decouverte groupes${label ? ` (${label})` : ''}: ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  );
}

/**
 * Schedules an exponential-backoff WebSocket reconnect attempt
 * (delays: 1s, 2s, 4s … 30s max). No-op when already logged out or a timer is pending.
 *
 * THE LADDER HAS NO LAST RUNG, AND THAT IS THE FIX (WP-RECONNECT-1, 2026-08-14).
 *
 * It used to stop after MAX_RECONNECT_ATTEMPTS (20 attempts over a ~8 minute budget), latch a
 * `reconnectCircuitOpen` flag, and refuse every later attempt. The flag's own message named what
 * would recover it - "until the app returns to the foreground or the network changes" - and A WHOLE
 * CLASS OF CLIENT CAN EMIT NEITHER EVENT: a desktop tab left in the foreground on an unchanged
 * network produces no `visibilitychange` and no `online`, ever. Measured on two production tabs
 * after a server outage: `navigator.onLine === true`, `visibilityState === 'visible'`, pages seven
 * hours old, the connection watchdog still firing every 60 s, and ZERO reconnect attempts and ZERO
 * sockets opened in a 135 s window. The badge read "Hors-ligne" and was honest. Only a reload
 * recovered them - which is a manual step for a fault the app created itself.
 *
 * SO TERMINATION NOW COMES FROM A PROOF, never from a count of failures. There are exactly two
 * proofs that retrying is pointless, and both are already here:
 *   - `!ctx.isLoggedIn()` - there is no session to carry.
 *   - `SessionExpiredError` in {@link attemptReconnectImpl} - the refresh cookie answered 401/403,
 *     which is an ANSWER rather than a transport failure. It logs out and redirects to /login.
 * A transport failure is not an answer and must never end the loop, however often it repeats.
 *
 * The cost of retrying for ever is what makes this safe rather than merely correct: the backoff
 * caps at 30 s, so a stuck tab settles at two connect attempts per minute - the same order as the
 * connection watchdog that is already running beside it, and orders of magnitude below what the
 * tab costs while it is actually connected. `reconnectAttempts` survives only as the index into
 * RECONNECT_DELAYS, and `openGatewayConnection` resets it to 0 the moment a socket opens.
 */
export function scheduleReconnectImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  if (!ctx.isLoggedIn()) return;
  ctx.setIsWsConnected(false);
  if (ctx.timers.reconnect !== null || ctx.isReconnecting()) return;

  const attempt = ctx.getReconnectAttempts() + 1;
  const delay =
    ctx.RECONNECT_DELAYS[Math.min(ctx.getReconnectAttempts(), ctx.RECONNECT_DELAYS.length - 1)];
  ctx.setReconnectAttempts(attempt);
  cb.log(`Connection lost. Retrying in ${delay / 1000}s... (attempt ${attempt})`);
  ctx.timers.reconnect = setTimeout(() => attemptReconnectImpl(ctx, cb), delay);
}

/**
 * Performs one WebSocket reconnect with full post-connect sync (same as login).
 * Falls back to scheduleReconnectImpl on failure.
 *
 * THE FALLBACK IS SCHEDULED AFTER `isReconnecting` GOES DOWN, and it has to be. Both failure paths
 * used to call `scheduleReconnectImpl` from inside the `try`, where `isReconnecting` is still true -
 * and that is precisely one of the two conditions on which `scheduleReconnectImpl` returns without
 * doing anything. So every rung the ladder tried to schedule for itself was dropped in silence,
 * after logging "Retrying in Ns...", and the only thing that actually re-tried was the 60 s
 * connection watchdog. The backoff ladder was never climbed by the ladder; it was climbed once per
 * minute by something else, which is why 20 attempts took twenty minutes rather than eight.
 */
export async function attemptReconnectImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  // CLEARED, not just forgotten. When the timer itself invoked us this is a no-op on an id that has
  // already fired; when `resumeConnectionImpl` calls us directly a rung of the ladder is still armed,
  // and merely dropping the reference left it running - it fired later, orphaned the rung scheduled
  // in the meantime, and the two ladders climbed in parallel. Harmless while the circuit capped the
  // whole thing at 20 attempts; not harmless now that it does not.
  if (ctx.timers.reconnect !== null) {
    clearTimeout(ctx.timers.reconnect);
    ctx.timers.reconnect = null;
  }
  if (!ctx.isLoggedIn() || ctx.isReconnecting()) return;
  if (!getIsTabLeader()) {
    cb.log('[TAB] Follower tab - reconnect skipped.');
    return;
  }
  ctx.setIsReconnecting(true);
  /** Set by every failure that is a TRANSPORT failure; the session-expired answer leaves it false. */
  let retry = false;
  try {
    cb.log('Reconnecting...');
    const mlsService = ctx.ensureMls();
    const connectionDeps = {
      mlsService,
      userId: ctx.getUserId(),
      deviceKeyB64: ctx.getDeviceKey(),
      scheduleReconnect: () => scheduleReconnectImpl(ctx, cb),
      setIsWsConnected: (v: boolean) => ctx.setIsWsConnected(v),
      setReconnectAttempts: (v: number) => ctx.setReconnectAttempts(v),
      processDeviceInvitationsLocally: () => processDeviceInvitationsLocally(ctx, cb),
      log: cb.log,
      onGroupMissing: (groupId: string) =>
        requestReAdd(groupId, makeRecoveryDeps(ctx, cb), ctx.connectionRecoveryTimers),
      onGroupDeletedRemotely: (groupId: string) =>
        markConversationDeletedRemotely(
          cb.conversations,
          groupId,
          ctx.getUserId(),
          cb.saveConversation
        ),
    };
    const connected = await openGatewayConnection(connectionDeps);
    if (!connected) {
      retry = true;
      return;
    }
    await syncConnectionAfterWsOpen(connectionDeps);
    runGroupDiscoveryImpl(ctx, cb, ctx.ensureMls(), 'reconnect');
  } catch (err) {
    if (err instanceof Error && err.name === 'SessionExpiredError') {
      ctx.setIsLoggedIn(false);
      cb.log('[AUTH] Session expired - redirecting to /login.');
      console.warn('[WS] Session expired, stopping reconnect loop');
      void goto('/login', { replaceState: true });
      return;
    }
    cb.log(`Reconnection failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('[WS] Reconnection failed:', err instanceof Error ? err.message : err);
    retry = true;
  } finally {
    ctx.setIsReconnecting(false);
    // Only here is the flag down, so only here can the next rung actually be armed. `return` inside
    // the try still reaches this, which is what makes the `!connected` path work.
    if (retry) scheduleReconnectImpl(ctx, cb);
  }
}

/**
 * Pauses the WebSocket connection and stops all background timers.
 * Called when the app is backgrounded.
 */
export function pauseConnectionImpl(ctx: SessionContext): void {
  if (ctx.timers.reconnect !== null) {
    clearTimeout(ctx.timers.reconnect);
    ctx.timers.reconnect = null;
  }
  if (ctx.timers.health !== null) {
    clearInterval(ctx.timers.health);
    ctx.timers.health = null;
  }
  if (ctx.timers.syncWatchdog !== null) {
    clearInterval(ctx.timers.syncWatchdog);
    ctx.timers.syncWatchdog = null;
  }
  stopConnectionWatchdogImpl(ctx);
  ctx.getStorage(); // no-op read to keep the pattern, actual disconnect below
  // MLS service disconnect
  // Note: mls is accessed via ctx.ensureMls() - but sendDisconnect must NOT create the service.
  // We check via getStorage (present when logged in) and call directly via the ensureMls guard.
  try {
    const svc = ctx.ensureMls();
    svc.sendDisconnect?.();
  } catch {
    // Service not initialised - safe to ignore.
  }
  ctx.setIsWsConnected(false);
  appendLog('[LIFECYCLE] App in background - connection paused.');
}

/**
 * Resumes after a foreground transition: re-arms everything `pauseConnectionImpl` stopped, closes
 * the reconnect circuit, then reconnects if the socket is down.
 *
 * THE RE-ARM IS THE POINT, and it is why this must run even when the socket survived the
 * background. `pauseConnectionImpl` stops the connection watchdog and the sync watchdog on every
 * background, and nothing else ever starts them again - they are armed exactly once, at login. So
 * after a single background/foreground cycle a mobile client had no timer left that could notice a
 * dead socket, and one that died later stayed dead in silence. Measured on hardware 2026-08-10:
 * ~20 minutes parked on /chat with the "En attente de connexion" banner up, ZERO reconnect
 * attempts in logcat, HTTP working throughout, and a reconnect 330 ms after a network change.
 *
 * Resetting the backoff is the other half, and it is now the ONLY half - the reconnect circuit this
 * function used to close no longer exists (WP-RECONNECT-1, see {@link scheduleReconnectImpl}). Both
 * triggers still land here (`ChatBackgroundService.handleVisibilityChange` and `handleOnlineResume`)
 * rather than each deciding for itself what to reset: evidence that conditions changed means the
 * ladder should restart at 1 s instead of resuming at its 30 s cap, so a device whose wifi returns
 * while the user is looking at the app reconnects at once rather than up to half a minute later.
 *
 * THE CORRECTNESS OF THE RECONNECTION NO LONGER DEPENDS ON EITHER TRIGGER FIRING, which is the whole
 * point of removing the circuit: these two events make recovery FASTER, they are not what makes it
 * possible. A client that emits neither still climbs the ladder for ever.
 */
export async function resumeConnectionImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  if (!ctx.isLoggedIn()) return;
  appendLog('[LIFECYCLE] App in foreground - re-arming watchdogs and reconnecting...');
  ctx.setReconnectAttempts(0);
  startConnectionWatchdogImpl(ctx, cb);
  startSyncWatchdogImpl(ctx, cb);
  if (ctx.isWsConnected()) return;
  await attemptReconnectImpl(ctx, cb);
}

/**
 * Starts a periodic watchdog that detects a dead WebSocket while the UI still shows online.
 * No-op if already running. Cleared on logout and pauseConnection.
 */
export function startConnectionWatchdogImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  if (ctx.timers.connectionWatchdog !== null) return;
  ctx.timers.connectionWatchdog = setInterval(() => {
    if (!ctx.isLoggedIn() || !getIsTabLeader()) return;
    try {
      const svc = ctx.ensureMls();
      if (svc?.isWsOpen()) return;
    } catch {
      // Service not initialised.
    }
    if (ctx.isWsConnected()) ctx.setIsWsConnected(false);
    if (ctx.timers.reconnect !== null || ctx.isReconnecting()) return;
    cb.log('[WS] Watchdog: socket inactive, reconnecting...');
    scheduleReconnectImpl(ctx, cb);
  }, CONNECTION_WATCHDOG_MS);
}

/** Stops the connection watchdog interval if running. */
export function stopConnectionWatchdogImpl(ctx: SessionContext): void {
  if (ctx.timers.connectionWatchdog !== null) {
    clearInterval(ctx.timers.connectionWatchdog);
    ctx.timers.connectionWatchdog = null;
  }
}
