/**
 * Promotion of an offline session to a fully connected one.
 *
 * A session unlocked with no network (see `offlineCapable` in `sessionAuth.ts`) holds a working
 * MLS state, a readable local message store and an accepting outbox - but no access token, no
 * WebSocket, and no push registration. This module performs the one sequence that turns it into an
 * ordinary session, and it is the only place that decides what "reconnecting" means.
 *
 * Nothing about authentication is deferred to here. The two paths that can unlock offline are
 * exactly the paths that never ask the server about the PIN even when online, so there is no
 * verification debt to settle. What IS settled here is whether the session is still alive at all:
 * a refresh answering 401/403 is the server saying this session is gone (expired, or revoked while
 * the device was away), and that logs the user out. A transport failure says nothing, and leaves
 * the session offline for the next attempt.
 */
import { getToken, SessionExpiredError } from '$lib/stores/auth';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { startPushService } from '$lib/services/PushNotificationService';
import { initializeConnection, getIsTabLeader } from '$lib/utils/chat/connection';
import { flushOutbox, applyOutboxPendingStatuses } from '$lib/utils/chat/outbox';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { runGroupDiscoveryImpl, startConnectionWatchdogImpl } from './sessionConnection';
import { startSyncWatchdogImpl } from './sessionWatchdogs';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';

/**
 * Builds the argument for `initializeConnection`. Injected rather than imported from
 * `sessionAuth`, which is what owns `makeConnectionDeps`: importing it here would close an import
 * cycle between the two modules for a single function reference.
 */
export type ConnectionDepsFactory = () => Parameters<typeof initializeConnection>[0];

/**
 * Single-flight guard. A flapping link fires `online` repeatedly and the browser may report it
 * alongside a visibility change, so without this the promotion stacks - and each copy opens its
 * own WebSocket. This is the same failure `checkPresenceNow` shows without an in-flight guard.
 */
let promotionInFlight: Promise<void> | null = null;

/** Unsubscribes the currently registered reconnect listener, if any. */
let unsubscribe: (() => void) | null = null;

/**
 * Promotes the session if it is offline. A no-op on a session that already holds a token: an
 * ordinary session that loses its socket is the reconnect watchdog's business, not this module's.
 *
 * Safe to call repeatedly; concurrent calls share one run.
 */
export function promoteOfflineSession(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  makeConnectionDeps: ConnectionDepsFactory
): Promise<void> {
  if (!ctx.isLoggedIn() || !ctx.isOfflineSession()) return Promise.resolve();
  if (promotionInFlight) return promotionInFlight;

  promotionInFlight = runPromotion(ctx, cb, makeConnectionDeps).finally(() => {
    promotionInFlight = null;
  });
  return promotionInFlight;
}

/** The promotion sequence proper. Never throws: a failed attempt simply leaves the session offline. */
async function runPromotion(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  makeConnectionDeps: ConnectionDepsFactory
): Promise<void> {
  cb.log('[PROMOTE] Network is back - promoting the offline session.');

  // 1. The token. This is the only step whose failure is meaningful.
  let token: string;
  try {
    token = await getToken();
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      // The server answered: this session is dead. Log out. The local encrypted store is NOT
      // touched - this is not a PIN reset - so signing back in restores the full history.
      cb.log('[PROMOTE] Session expired while offline - signing out.');
      cb.onSessionExpired?.();
      return;
    }
    // Still no usable network. Stay offline and wait for the next reconnect signal.
    cb.log(`[PROMOTE] Token still unavailable, staying offline: ${String(err)}`);
    connectivity.notifyServerUnreachable();
    return;
  }

  ctx.setAuthToken(token);
  ctx.setIsOfflineSession(false);
  cb.log('[PROMOTE] Access token acquired - session is online.');

  // 2. Push registration, skipped at login. The FCM/APNs token may have rotated while the device
  //    was away, so this re-registers rather than merely retries.
  if (isTauriRuntime()) {
    void startPushService(ctx.getHistoryBaseUrl(), token, ctx.getMyDeviceId())
      .then(() => cb.log('[PROMOTE] Push token registered.'))
      .catch((e) => cb.log(`[PROMOTE] Push registration failed (non-blocking): ${String(e)}`));
  }

  // 3. The WebSocket and the post-connect reconciliation: the same sequence login runs, so the
  //    KeyPackages get published, `fetchPendingMessages` drains everything the server queued while
  //    we were away, and group state is reconciled under its own anti-purge guard.
  try {
    await initializeConnection(makeConnectionDeps());
  } catch (e) {
    cb.log(`[PROMOTE] Connection failed: ${String(e)}`);
    // initializeConnection already scheduled its own reconnect backoff; the watchdogs below take
    // it from here now that a real token exists.
  }

  // 4. Only NOW may the outbox drain. Its own `online` listener would have fired before step 1,
  //    with an empty token: every send would have failed and burnt an attempt on the entry it was
  //    trying to save. Ordering this after the connection is the whole point.
  flushOutbox();
  await applyOutboxPendingStatuses().catch(() => {});

  // 5. Background upkeep that login skips on an offline session. Starting the connection watchdog
  //    earlier would have burnt the reconnect budget against a network that was not there and left
  //    the circuit open.
  if (getIsTabLeader()) {
    runGroupDiscoveryImpl(ctx, cb, ctx.ensureMls());
    startSyncWatchdogImpl(ctx, cb);
    startConnectionWatchdogImpl(ctx, cb);
  }

  cb.log('[PROMOTE] Offline session fully promoted.');
}

/**
 * Subscribes the promotion to connectivity being regained. Called once per login; the returned
 * teardown also runs from `logoutImpl` so a stale context cannot be promoted after sign-out.
 */
export function registerOfflinePromotion(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  makeConnectionDeps: ConnectionDepsFactory
): void {
  unregisterOfflinePromotion();
  unsubscribe = connectivity.onReconnect(() => {
    void promoteOfflineSession(ctx, cb, makeConnectionDeps);
  });
}

/** Detaches the reconnect listener and forgets any in-flight promotion. */
export function unregisterOfflinePromotion(): void {
  unsubscribe?.();
  unsubscribe = null;
  promotionInFlight = null;
}
