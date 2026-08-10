import { SvelteMap } from 'svelte/reactivity';

/**
 * The phase of the ONE outstanding history solicitation a group may have.
 *
 * This tracks an attempt; it does not drive one. It used to own a retry ladder of its own
 * (`RETRY_DELAYS_MS`, `MAX_RETRIES`) while `historySolicit` owned a second, independent one, so the
 * traffic a single group could produce was the product of two schedules and no single place could be
 * read to predict it. Asking is now the sole business of `historySolicit`, which sends exactly one
 * request per edge and converges because each exchange is a diff - see `solicitHistory`.
 *
 * - `pending`: a request went out and the response window is still open.
 * - `pending-offline`: the window elapsed, or the request never left the device. Nothing is
 *   outstanding; the next state edge - a reconnect, a peer coming online, the awaiting sweep - is
 *   what asks again.
 */
export type HistoryRequestPhase = 'pending' | 'pending-offline';

type PendingEntry = {
  phase: HistoryRequestPhase;
  /** Fires when the response window elapses. The only timer in the history-repair mechanism. */
  timeoutId: ReturnType<typeof setTimeout>;
};

/**
 * How long an answer may take before the attempt counts as over.
 *
 * The one duration the mechanism cannot do without: "this request will not be answered" is not
 * observable any other way. It ends an attempt and schedules nothing, so it can never itself
 * generate traffic.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** In-memory registry of outstanding history request windows, keyed by MLS group id. */
const entries = new SvelteMap<string, PendingEntry>();

/**
 * Reactive map exposing the current phase for each group awaiting a history bundle.
 * UI components read this directly (e.g. `historyRequestPendingStore.phases.get(groupId)`).
 */
class HistoryRequestPendingStore {
  readonly phases = new SvelteMap<string, HistoryRequestPhase>();

  /** Opens the response window for a request that has just gone out. */
  start(groupId: string): void {
    this.ensureGlobalListeners();
    this.clearTimer(groupId);
    entries.set(groupId, {
      phase: 'pending',
      timeoutId: setTimeout(() => this.onTimeout(groupId), REQUEST_TIMEOUT_MS),
    });
    this.phases.set(groupId, 'pending');
    console.log(`[HISTORY_REQ] response window open for ${groupId.slice(0, 8)}...`);
  }

  /** The request never left the device (offline, no member online). The attempt is over. */
  markOffline(groupId: string): void {
    const entry = entries.get(groupId);
    if (!entry || entry.phase === 'pending-offline') return;
    clearTimeout(entry.timeoutId);
    entry.phase = 'pending-offline';
    this.phases.set(groupId, 'pending-offline');
    console.log(`[HISTORY_REQ] ${groupId.slice(0, 8)}... could not be asked - attempt over`);
  }

  /** The current phase for `groupId`, or null when no attempt is being tracked. */
  getPhase(groupId: string): HistoryRequestPhase | null {
    return this.phases.get(groupId) ?? null;
  }

  /** The bundle arrived, or the attempt was cancelled: stop tracking it. */
  noteReceived(groupId: string): void {
    if (!entries.has(groupId)) return;
    this.clearTimer(groupId);
    entries.delete(groupId);
    this.phases.delete(groupId);
    console.log(`[HISTORY_REQ] attempt for ${groupId.slice(0, 8)}... settled`);
  }

  /** Cancels every tracked window (session teardown / logout). */
  cancelAll(): void {
    for (const [groupId] of entries) this.noteReceived(groupId);
  }

  /**
   * The app came back online or to the foreground.
   *
   * It drops the offline phases so the UI stops claiming an attempt is outstanding, and does NOT
   * ask again: re-soliciting is `reSolicitAwaitingHistory`'s single job, and the reconnect this
   * resume triggers is what calls it. Two callers asking on one edge is how the duplicate ladders
   * started.
   */
  onResume(): void {
    // Deleting the current entry mid-iteration is well defined for a Map, so no copy is needed.
    for (const [groupId, entry] of entries) {
      if (entry.phase === 'pending-offline') this.noteReceived(groupId);
    }
  }

  private onTimeout(groupId: string): void {
    const entry = entries.get(groupId);
    if (!entry || entry.phase !== 'pending') return;
    entry.phase = 'pending-offline';
    this.phases.set(groupId, 'pending-offline');
    console.log(`[HISTORY_REQ] no answer for ${groupId.slice(0, 8)}... - attempt over`);
  }

  private clearTimer(groupId: string): void {
    const entry = entries.get(groupId);
    if (entry) clearTimeout(entry.timeoutId);
  }

  private listenersInstalled = false;

  private ensureGlobalListeners(): void {
    if (this.listenersInstalled || typeof window === 'undefined') return;
    this.listenersInstalled = true;

    window.addEventListener('online', () => this.onResume());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.onResume();
    });
  }
}

export const historyRequestPendingStore = new HistoryRequestPendingStore();
