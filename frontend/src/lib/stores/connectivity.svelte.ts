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

import { RequestDeadlineError } from '$lib/utils/requestDeadline';

/** Callback invoked when connectivity is regained (offline -> online). */
export type ReconnectListener = () => void;

/**
 * The `slow` state is DERIVED FROM WHAT ANSWERS ACTUALLY TOOK, not from a guess about the link
 * (WP-OFF-5). Two readings feed it, and each has a stated reason:
 *
 * - **Smoothed answer latency.** An exponentially-weighted mean (alpha 0.3, so ~5 samples settle it)
 *   of the time to the response head of every ordinary call. Measured on this app's estate, a good
 *   link answers a small GET in ~16 ms, the Slow 3G profile (400 ms RTT) in ~440 ms and the 2G-like
 *   profile (800 ms RTT) in ~960 ms (CDP, 2026-10-09, [offline-and-weak-network]). The state is
 *   entered at 700 ms - between Slow 3G, which is slow but workable and earns no strip, and the
 *   2G-like profile, where every screen visibly waits - and left at 350 ms, below Slow 3G: the gap is
 *   hysteresis, so a link hovering at the threshold does not make the hint flicker.
 * - **A request still unanswered after 5 s.** The smoothed value only moves when an answer arrives,
 *   so a link that has just gone quiet would show nothing for the whole deadline. One request
 *   unanswered for 5 s is, by the numbers above, five times the worst measured profile's answer.
 *
 * Neither can cause load, only a hint: if either were wrong, a calm line of text would be wrong.
 */
export const SLOW_ENTER_MS = 700;
export const SLOW_EXIT_MS = 350;
export const SLOW_IN_FLIGHT_MS = 5_000;
/**
 * How late the in-flight timer may fire before the delay is blamed on THIS DEVICE rather than the
 * link. The timer measures wall time, and a renderer whose single thread is busy (decoding a queued
 * 13 MB attachment, 2026-10-10, Pixel 6a) fires it seconds late and delays every response handler by
 * as much - a "slow link" that is only a slow phone. A timer that ran this far behind its own
 * schedule proves nothing about the network, so it raises no hint.
 */
export const LOOP_LAG_TOLERANCE_MS = 1_000;
const LATENCY_ALPHA = 0.3;
/** Samples needed before the smoothed value may enter `slow` - one outlier is not a link. */
const MIN_SAMPLES = 3;
/**
 * Consecutive deadline expiries (with no answer in between) after which the server is treated as
 * unreachable. One expiry is a slow or lossy moment; two in a row with nothing answered is the
 * black-holed link that raises no error at all.
 */
export const STALLS_BEFORE_UNREACHABLE = 2;

/**
 * Asks the server whether it is there. Resolves true when ANY answer came back, false when none did.
 * Supplied from outside (`reachabilityProbe.ts`) so this store imports no URL and no network code.
 */
export type ReachabilityProbe = () => Promise<boolean>;

/**
 * Pauses (ms) between the probes of one resume, and so also how many there are. BOUNDED ON PURPOSE:
 * a resume sends at most four tiny GETs per event, doubling apart, each jittered by +-25 % so two
 * devices coming back together do not probe in lockstep. After the last one the store stops asking
 * and waits for the browser's next `online` event or any request that succeeds - it never polls.
 * `online` probes at once; a transition to unreachable waits a second first, because the failure it
 * follows is the best evidence the link is still down.
 */
export const PROBE_DELAYS_AFTER_ONLINE_MS = [0, 1_000, 2_000, 4_000];
export const PROBE_DELAYS_AFTER_FAILURE_MS = [1_000, 2_000, 4_000, 8_000];

/** A request counted by {@link ConnectivityStore.trackRequest}; settle it exactly once. */
export interface TrackedRequest {
  /** The server answered (any status). `latencyMs` is excluded from the average when `measured` is false. */
  answered(measured?: boolean): void;
  /** The request failed before an answer: a transport failure, a deadline expiry or a cancellation. */
  failed(error: unknown): void;
}

class ConnectivityStore {
  /** `navigator.onLine`, kept in sync with the `online`/`offline` events. Optimistic by nature. */
  isOnline = $state(true);

  /**
   * True until a request fails at transport level, then again once any request succeeds.
   * Starts optimistic: nothing has failed yet, so nothing justifies degrading the UI.
   */
  serverReachable = $state(true);

  /**
   * True while answers are arriving but slowly (see {@link SLOW_ENTER_MS}). Never set while
   * offline: a link that reaches nothing is `isOffline`, and the two hints must not stack.
   */
  slow = $state(false);

  /** Smoothed time-to-response-head in ms, 0 until the first answer. Exposed for diagnostics and tests. */
  latencyMs = 0;
  private samples = 0;
  private latencySlow = false;
  private inFlightSlow = false;
  private consecutiveStalls = 0;
  private nextRequestId = 0;
  private readonly inFlight = new Map<number, ReturnType<typeof setTimeout>>();

  /** True when the app should behave as offline: no network, or a network that reaches nothing. */
  get isOffline(): boolean {
    return !this.isOnline || !this.serverReachable;
  }

  private probe: ReachabilityProbe | null = null;
  private probing = false;
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
      // run now - they are what performs that call. And since waiting for SOME call to happen is
      // what made a resume take 3.8-5.3 s, the probe below makes that call right away (WP-OFF-6).
      this.emitReconnect();
      void this.probeUntilReachable(PROBE_DELAYS_AFTER_ONLINE_MS, 'online event');
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
    this.recomputeSlow();
    // The browser still believes it has a link, so no `online` event will ever announce its return:
    // something has to ask. Only when the browser does not already say it is offline - then the
    // `online` event is the trigger and this would be a probe into a known-dead link.
    if (this.isOnline) {
      void this.probeUntilReachable(PROBE_DELAYS_AFTER_FAILURE_MS, 'transport failure');
    }
  }

  /** Registers the reachability probe. `null` removes it (tests). */
  setReachabilityProbe(probe: ReachabilityProbe | null): void {
    this.probe = probe;
  }

  /**
   * Probes the server until it answers, over a bounded number of attempts (see
   * {@link PROBE_DELAYS_AFTER_ONLINE_MS}). SINGLE-FLIGHT: a second trigger while one runs joins it
   * rather than starting another, so a flapping link cannot multiply probes. The answer itself is
   * recorded by the probe's own `trackedFetch` - `notifyServerReachable` fires reconnect listeners
   * (the outbox flush) exactly as any successful request would, with no second path.
   */
  private async probeUntilReachable(delaysMs: readonly number[], reason: string): Promise<void> {
    if (!this.probe || this.probing) return;
    this.probing = true;
    try {
      for (let attempt = 0; attempt < delaysMs.length; attempt++) {
        const pause = delaysMs[attempt] * (0.75 + Math.random() * 0.5);
        if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
        // Someone else answered, or the link left again: nothing left to find out.
        if (this.serverReachable || !this.isOnline) return;
        const answered = await this.probe().catch(() => false);
        if (answered) {
          console.log(`[CONNECTIVITY] probe answered (${reason}, attempt ${attempt + 1})`);
          return;
        }
      }
      console.warn(
        `[CONNECTIVITY] ${delaysMs.length} probe(s) after ${reason} got no answer - waiting for the next online event or any successful request`
      );
    } finally {
      this.probing = false;
    }
  }

  /**
   * Starts counting a request that left the device. Every REST call goes through here (via
   * `trackedFetch`), so the store sees the whole population rather than the calls that happen to
   * be interesting. Settle the returned handle exactly once.
   */
  trackRequest(opts: { transfer?: boolean } = {}): TrackedRequest {
    this.ensureGlobalListeners();
    const id = this.nextRequestId++;
    const startedAt = Date.now();
    // A TRANSFER (a body big enough that its time is mostly upload) is not a probe of the link: it
    // is unanswered for as long as the bytes take to leave, which is the bandwidth, not the latency.
    // It is still counted for reachability and stalls; it just never arms the in-flight hint.
    // Re-armed after a late fire: the busy spell is forgiven ONCE, but a request that is still
    // unanswered a full threshold later is measured again, so a really stalled one still raises it.
    const arm = (): void => {
      const armedAt = Date.now();
      this.inFlight.set(
        id,
        setTimeout(() => {
          if (!this.inFlight.has(id) || opts.transfer) return;
          const lagMs = Date.now() - armedAt - SLOW_IN_FLIGHT_MS;
          if (lagMs > LOOP_LAG_TOLERANCE_MS) {
            console.debug(
              `[CONNECTIVITY] in-flight timer ran ${Math.round(lagMs)} ms late - this device was busy, not the link; re-armed`
            );
            arm();
            return;
          }
          this.inFlightSlow = true;
          this.recomputeSlow();
        }, SLOW_IN_FLIGHT_MS)
      );
    };
    arm();
    const settle = (): void => {
      const timer = this.inFlight.get(id);
      if (timer === undefined) return;
      clearTimeout(timer);
      this.inFlight.delete(id);
      // Nothing is left waiting past the threshold once the last slow request has settled.
      if (this.inFlight.size === 0) this.inFlightSlow = false;
    };
    return {
      answered: (measured = true) => {
        if (!this.inFlight.has(id)) return;
        settle();
        this.consecutiveStalls = 0;
        this.notifyServerReachable();
        if (measured) this.observeLatency(Date.now() - startedAt);
        this.recomputeSlow();
      },
      failed: (error) => {
        if (!this.inFlight.has(id)) return;
        settle();
        if (error instanceof RequestDeadlineError) {
          this.consecutiveStalls++;
          console.warn(
            `[CONNECTIVITY] ${error.message} (stall ${this.consecutiveStalls}/${STALLS_BEFORE_UNREACHABLE})`
          );
          if (this.consecutiveStalls >= STALLS_BEFORE_UNREACHABLE) this.notifyServerUnreachable();
        } else if (isTransportFailure(error)) {
          this.notifyServerUnreachable();
        }
        this.recomputeSlow();
      },
    };
  }

  /** Folds one answer's time-to-head into the smoothed latency. */
  private observeLatency(ms: number): void {
    this.latencyMs =
      this.samples === 0 ? ms : this.latencyMs + LATENCY_ALPHA * (ms - this.latencyMs);
    this.samples++;
    if (this.samples >= MIN_SAMPLES && this.latencyMs >= SLOW_ENTER_MS) this.latencySlow = true;
    else if (this.latencyMs <= SLOW_EXIT_MS) this.latencySlow = false;
  }

  /** Derives `slow` from its two readings; logged only on a change so a flapping link stays one line each way. */
  private recomputeSlow(): void {
    const next = !this.isOffline && (this.latencySlow || this.inFlightSlow);
    if (next === this.slow) return;
    this.slow = next;
    console.log(
      next
        ? `[CONNECTIVITY] slow link (smoothed answer ${Math.round(this.latencyMs)} ms, ${this.inFlight.size} request(s) in flight)`
        : `[CONNECTIVITY] link no longer slow (smoothed answer ${Math.round(this.latencyMs)} ms)`
    );
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
    this.probe = null;
    this.probing = false;
    for (const timer of this.inFlight.values()) clearTimeout(timer);
    this.inFlight.clear();
    this.slow = false;
    this.latencyMs = 0;
    this.samples = 0;
    this.latencySlow = false;
    this.inFlightSlow = false;
    this.consecutiveStalls = 0;
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
  // A deadline expiry is the absence of an answer, never one - recognised by TYPE, raised where the
  // deadline was armed.
  if (error instanceof RequestDeadlineError) return true;
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /network|failed to fetch|fetch failed|load failed|connection/i.test(error.message);
}
