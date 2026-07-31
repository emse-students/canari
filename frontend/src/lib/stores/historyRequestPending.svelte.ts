import { SvelteMap } from 'svelte/reactivity';

/**
 * Per-request phase for a history solicitation.
 * - `pending`: a request was sent and the 30 s response window is still open.
 * - `pending-offline`: the response window elapsed without a bundle; retries are scheduled.
 */
export type HistoryRequestPhase = 'pending' | 'pending-offline';

type PendingEntry = {
  phase: HistoryRequestPhase;
  /** Timer that fires when the current request window elapses. */
  timeoutId: ReturnType<typeof setTimeout>;
  /** Timer for the next scheduled retry when offline. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Number of retries already consumed for this group. */
  retryCount: number;
  /** Callback that triggers a new `sendHistoryRequest(groupId)` call. */
  retry: () => void;
};

const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff (ms) between retries after a request timed out or failed offline. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
const MAX_RETRIES = 3;

/** In-memory registry of in-flight history request windows, keyed by MLS group id. */
const entries = new Map<string, PendingEntry>();

/**
 * Reactive map exposing the current phase for each group that is awaiting a history bundle.
 * UI components read this directly (e.g. `historyRequestPendingStore.phases.get(groupId)`).
 */
class HistoryRequestPendingStore {
  readonly phases = new SvelteMap<string, HistoryRequestPhase>();

  /**
   * Registers a fresh history request for `groupId` and starts its response timeout.
   * If a pending window already exists for the same group it is restarted (new attempt),
   * but the retry counter is preserved so the overall retry budget is not reset.
   */
  start(groupId: string, retry: () => void): void {
    this.ensureGlobalListeners();

    const existing = entries.get(groupId);
    if (existing) {
      clearTimeout(existing.timeoutId);
      if (existing.retryTimer) {
        clearTimeout(existing.retryTimer);
        existing.retryTimer = null;
      }
      existing.phase = 'pending';
      existing.retry = retry;
      existing.timeoutId = setTimeout(() => this.onTimeout(groupId), REQUEST_TIMEOUT_MS);
      this.phases.set(groupId, 'pending');
      console.log(`[HISTORY_REQ] restarted pending timer for ${groupId.slice(0, 8)}...`);
      return;
    }

    const entry: PendingEntry = {
      phase: 'pending',
      timeoutId: setTimeout(() => this.onTimeout(groupId), REQUEST_TIMEOUT_MS),
      retryTimer: null,
      retryCount: 0,
      retry,
    };
    entries.set(groupId, entry);
    this.phases.set(groupId, 'pending');
    console.log(`[HISTORY_REQ] started pending timer for ${groupId.slice(0, 8)}...`);
  }

  /**
   * Signals that the current request failed to leave the network layer (e.g. browser offline).
   * Moves the group straight to `pending-offline` and schedules a retry.
   */
  markOffline(groupId: string): void {
    const entry = entries.get(groupId);
    if (!entry) return;
    if (entry.phase === 'pending-offline') return;
    clearTimeout(entry.timeoutId);
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    entry.phase = 'pending-offline';
    this.phases.set(groupId, 'pending-offline');
    console.log(
      `[HISTORY_REQ] network failure for ${groupId.slice(0, 8)}..., moved to pending-offline`
    );
    this.scheduleRetry(groupId);
  }

  /** Returns the current phase for `groupId`, or null when no request is in flight. */
  getPhase(groupId: string): HistoryRequestPhase | null {
    return this.phases.get(groupId) ?? null;
  }

  /**
   * Stops tracking `groupId` because the history bundle arrived or the request was cancelled.
   * Clears timers and removes the reactive entry.
   */
  noteReceived(groupId: string): void {
    const entry = entries.get(groupId);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entries.delete(groupId);
    this.phases.delete(groupId);
    console.log(
      `[HISTORY_REQ] bundle received for ${groupId.slice(0, 8)}..., cleared pending state`
    );
  }

  /** Cancels all pending windows and retries (session teardown / logout). */
  cancelAll(): void {
    for (const [groupId] of entries) {
      this.noteReceived(groupId);
    }
  }

  /**
   * Triggered when the app comes back online or to the foreground.
   * Immediately retries every `pending-offline` group that still has retry budget left.
   */
  onResume(): void {
    for (const [groupId, entry] of entries) {
      if (entry.phase !== 'pending-offline') continue;
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
      if (entry.retryCount >= MAX_RETRIES) {
        console.log(
          `[HISTORY_REQ] resume skipped for ${groupId.slice(0, 8)}..., retry budget exhausted`
        );
        continue;
      }
      const delay = RETRY_DELAYS_MS[entry.retryCount];
      entry.retryCount += 1;
      console.log(
        `[HISTORY_REQ] resume trigger for ${groupId.slice(0, 8)}... (retry ${entry.retryCount}/${MAX_RETRIES})`
      );
      entry.retry();
      // After the immediate retry, re-arm the normal backoff so the request window + retry ladder
      // continues from this point.
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        entry.retry();
      }, delay);
    }
  }

  private onTimeout(groupId: string): void {
    const entry = entries.get(groupId);
    if (!entry || entry.phase !== 'pending') return;
    entry.phase = 'pending-offline';
    this.phases.set(groupId, 'pending-offline');
    console.log(`[HISTORY_REQ] timeout for ${groupId.slice(0, 8)}..., moved to pending-offline`);
    this.scheduleRetry(groupId);
  }

  private scheduleRetry(groupId: string): void {
    const entry = entries.get(groupId);
    if (!entry || entry.phase !== 'pending-offline') return;
    if (entry.retryCount >= MAX_RETRIES) {
      console.log(
        `[HISTORY_REQ] max retries reached for ${groupId.slice(0, 8)}..., waiting for online/foreground`
      );
      return;
    }
    // Avoid queuing two retry timers for the same group (e.g. timeout + immediate markOffline).
    if (entry.retryTimer) return;
    const delay = RETRY_DELAYS_MS[entry.retryCount];
    entry.retryCount += 1;
    console.log(
      `[HISTORY_REQ] retry ${entry.retryCount}/${MAX_RETRIES} scheduled for ${groupId.slice(0, 8)}... in ${delay}ms`
    );
    entry.retryTimer = setTimeout(() => {
      console.log(
        `[HISTORY_REQ] retry ${entry.retryCount}/${MAX_RETRIES} fired for ${groupId.slice(0, 8)}...`
      );
      entry.retryTimer = null;
      entry.retry();
    }, delay);
  }

  private listenersInstalled = false;

  private ensureGlobalListeners(): void {
    if (this.listenersInstalled || typeof window === 'undefined') return;
    this.listenersInstalled = true;

    window.addEventListener('online', () => {
      console.log('[HISTORY_REQ] network back online - checking pending-offline requests');
      this.onResume();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      console.log('[HISTORY_REQ] app back to foreground - checking pending-offline requests');
      this.onResume();
    });
  }
}

export const historyRequestPendingStore = new HistoryRequestPendingStore();
