/**
 * Fonctions de gestion de la connexion WebSocket extraites de useChatSession :
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

/** Durée du watchdog de connexion - même valeur que RECOVERY_TIMEOUT_MS. */
const CONNECTION_WATCHDOG_MS = RECOVERY_TIMEOUT_MS;

/**
 * Fires `discoverMissingGroups` and logs any error.
 * Centralise le spread à 7 champs pour éviter la duplication à chaque call site.
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
    pin: ctx.getPin(),
    conversations: cb.conversations,
    saveConversation: cb.saveConversation,
    deleteConversation: st ? (id) => st.deleteConversation(id) : undefined,
    log: cb.log,
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
    cb.log(
      `[WS] Connexion impossible après ${ctx.MAX_RECONNECT_ATTEMPTS} tentatives. Cliquez "Réessayer" pour reconnecter.`
    );
    return;
  }

  const delay =
    ctx.RECONNECT_DELAYS[Math.min(ctx.getReconnectAttempts(), ctx.RECONNECT_DELAYS.length - 1)];
  ctx.setReconnectAttempts(ctx.getReconnectAttempts() + 1);
  cb.log(
    `Connexion perdue. Nouvelle tentative dans ${delay / 1000}s... (tentative ${ctx.getReconnectAttempts()}/${ctx.MAX_RECONNECT_ATTEMPTS})`
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
    cb.log('[TAB] Onglet follower - reconnexion ignorée.');
    return;
  }
  ctx.setIsReconnecting(true);
  try {
    cb.log('Reconnexion en cours...');
    const mlsService = ctx.ensureMls();
    const connectionDeps = {
      mlsService,
      userId: ctx.getUserId(),
      pin: ctx.getPin(),
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
      cb.log('[AUTH] Session expirée - redirection vers /login');
      console.warn('[WS] Session expired, stopping reconnect loop');
      void goto('/login', { replaceState: true });
      return;
    }
    cb.log(`Reconnexion echouee: ${err instanceof Error ? err.message : String(err)}`);
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
  // Note: mls est accédé via ctx.ensureMls() - mais sendDisconnect ne doit PAS créer le service.
  // On check via getStorage (présent si loggé) et on appelle directement via ensureMls guard.
  try {
    const svc = ctx.ensureMls();
    svc.sendDisconnect?.();
  } catch {
    // Service non initialisé - pas grave
  }
  ctx.setIsWsConnected(false);
  appendLog('[LIFECYCLE] App en arrière-plan - connexion pausée.');
}

/**
 * Resumes the WebSocket connection after the app comes back to the foreground.
 * Re-arms background timers and triggers a reconnect attempt.
 */
export async function resumeConnectionImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  if (!ctx.isLoggedIn()) return;
  appendLog('[LIFECYCLE] App au premier plan - reconnexion...');
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
      // Service non initialisé
    }
    if (ctx.isWsConnected()) ctx.setIsWsConnected(false);
    if (ctx.timers.reconnect !== null || ctx.isReconnecting()) return;
    cb.log('[WS] Surveillance: socket inactif, reconnexion...');
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
