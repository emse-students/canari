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
 */
export function scheduleReconnectImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  if (!ctx.isLoggedIn()) return;
  ctx.setIsWsConnected(false);
  if (ctx.timers.reconnect !== null || ctx.isReconnecting()) return;

  if (ctx.isReconnectCircuitOpen()) return;
  if (ctx.getReconnectAttempts() >= ctx.MAX_RECONNECT_ATTEMPTS) {
    ctx.setReconnectCircuitOpen(true);
    // Say what actually recovers it. This used to read 'Click "Retry" to reconnect' and no such
    // control exists anywhere in the app - `reconnectCircuitOpen` is read by this function alone -
    // so the one message a stuck user could see named a button that was never built.
    cb.log(
      `[WS] Unable to connect after ${ctx.MAX_RECONNECT_ATTEMPTS} attempts - pausing retries until ` +
        `the app returns to the foreground or the network changes.`
    );
    return;
  }

  const delay =
    ctx.RECONNECT_DELAYS[Math.min(ctx.getReconnectAttempts(), ctx.RECONNECT_DELAYS.length - 1)];
  ctx.setReconnectAttempts(ctx.getReconnectAttempts() + 1);
  cb.log(
    `Connection lost. Retrying in ${delay / 1000}s... (attempt ${ctx.getReconnectAttempts()}/${ctx.MAX_RECONNECT_ATTEMPTS})`
  );
  ctx.timers.reconnect = setTimeout(() => attemptReconnectImpl(ctx, cb), delay);
}

/**
 * Performs one WebSocket reconnect with full post-connect sync (same as login).
 * Falls back to scheduleReconnectImpl on failure.
 */
export async function attemptReconnectImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  ctx.timers.reconnect = null;
  if (!ctx.isLoggedIn() || ctx.isReconnecting()) return;
  if (!getIsTabLeader()) {
    cb.log('[TAB] Follower tab - reconnect skipped.');
    return;
  }
  ctx.setIsReconnecting(true);
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
        markConversationDeletedRemotely(cb.conversations, groupId, cb.saveConversation),
    };
    const connected = await openGatewayConnection(connectionDeps);
    if (!connected) {
      scheduleReconnectImpl(ctx, cb);
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
    scheduleReconnectImpl(ctx, cb);
  } finally {
    ctx.setIsReconnecting(false);
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
 * Closing the circuit is the other half. It opens after MAX_RECONNECT_ATTEMPTS and nothing ever
 * closed it: a successful connect resets the attempt COUNT but not the circuit, and the watchdog
 * reaches for `scheduleReconnectImpl`, which returns early while it is open - so the one component
 * whose job is to notice a dead socket was disarmed by the same flag that made noticing matter.
 * Returning to the foreground is precisely the evidence that conditions may have changed, which is
 * what makes it the right seam to clear it from.
 */
export async function resumeConnectionImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  if (!ctx.isLoggedIn()) return;
  appendLog('[LIFECYCLE] App in foreground - re-arming watchdogs and reconnecting...');
  ctx.setReconnectCircuitOpen(false);
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
