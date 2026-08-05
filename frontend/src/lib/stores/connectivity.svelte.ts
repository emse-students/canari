/**
 * Reactive connectivity state for the whole app.
 *
 * Two facts are tracked, because neither one alone is the truth:
 *
 * - `isOnline` mirrors `navigator.onLine`. It is *optimistic*: a captive portal, a Wi-Fi network
 *   with no route out, or a backend that is simply down all report `true`. It is a fast negative
 *   signal ("definitely no network") and nothing more.
 * - `serverReachable` records whether the last call that actually left the device succeeded. That
 *   is the only positive evidence we ever get.
 *
 * `isOffline` derives from both, so a device that believes it is online but cannot reach the
 * backend is still treated as offline.
 *
 * Only a *transport* failure may clear `serverReachable`. An HTTP answer - any status, including
 * 401 or 502 - proves the server was reached, and must be handled by the caller as an answer, not
 * as a connectivity problem. Conflating the two is how a logged-in user gets signed out by a
 * flaky link.
 */

/** Callback invoked when connectivity is regained (offline -> online). */
export type ReconnectListener = () => void;

class ConnectivityStore {
  /** `navigator.onLine`, kept in sync with the `online`/`offline` events. Optimistic by nature. */
  isOnline = $state(true);

  /**
   * True until a request fails at transport level, then again once any request succeeds.
   * Starts optimistic: nothing has failed yet, so nothing justifies degrading the UI.
   */
  serverReachable = $state(true);

  /** True when the app should behave as offline: no network, or a network that reaches nothing. */
  get isOffline(): boolean {
    return !this.isOnline || !this.serverReachable;
  }

  private listeners = new Set<ReconnectListener>();
  private listenersInstalled = false;

  /**
   * Installs the `online`/`offline` window listeners once. Called from every mutator so a store
   * imported by a non-UI module (the outbox, the session) still tracks the browser events without
   * needing an explicit init call from a component.
   */
  private ensureGlobalListeners(): void {
    if (this.listenersInstalled || typeof window === 'undefined') return;
    this.listenersInstalled = true;
    this.isOnline = navigator.onLine;
    window.addEventListener('online', () => {
      console.log('[CONNECTIVITY] browser reports online');
      this.isOnline = true;
      // The browser regaining a link says nothing about the backend, so `serverReachable` is
      // deliberately left alone: the next successful call is what restores it. But listeners must
      // run now - they are what performs that call.
      this.emitReconnect();
    });
    window.addEventListener('offline', () => {
      console.log('[CONNECTIVITY] browser reports offline');
      this.isOnline = false;
    });
  }

  /** Records that a request reached the server (whatever it answered). */
  notifyServerReachable(): void {
    this.ensureGlobalListeners();
    if (this.serverReachable && this.isOnline) return;
    console.log('[CONNECTIVITY] server reachable again');
    const wasOffline = this.isOffline;
    this.serverReachable = true;
    this.isOnline = true;
    if (wasOffline) this.emitReconnect();
  }

  /**
   * Records that a request never reached the server (DNS failure, no route, refused socket).
   * Call this only for transport failures - an HTTP status is an answer, not a disconnection.
   */
  notifyServerUnreachable(): void {
    this.ensureGlobalListeners();
    if (!this.serverReachable) return;
    console.log('[CONNECTIVITY] server unreachable (transport failure)');
    this.serverReachable = false;
  }

  /**
   * Subscribes to connectivity being regained. Returns an unsubscribe function.
   * Listeners must be idempotent and cheap to re-enter: a flapping link fires this repeatedly.
   */
  onReconnect(listener: ReconnectListener): () => void {
    this.ensureGlobalListeners();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs every reconnect listener, isolating failures so one bad listener cannot starve the rest. */
  private emitReconnect(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.warn('[CONNECTIVITY] reconnect listener failed:', e);
      }
    }
  }

  /** Test seam: restores the initial state and drops every listener. */
  reset(): void {
    this.isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
    this.serverReachable = true;
    this.listeners.clear();
  }
}

/** Singleton connectivity state. Read `connectivity.isOffline` in components. */
export const connectivity = new ConnectivityStore();

/**
 * True when the given error is a transport-level failure rather than a server answer.
 *
 * `fetch` reports every transport failure as a bare `TypeError: fetch failed` (or
 * `NetworkError`/`Load failed` depending on the engine) with the real cause nested in `cause`, so
 * there is no status code to branch on. Anything that carries a status has, by definition, been
 * answered by the server and is not a connectivity problem.
 */
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /network|failed to fetch|fetch failed|load failed|connection/i.test(error.message);
}
