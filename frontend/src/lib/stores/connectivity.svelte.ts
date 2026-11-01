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
import { isTransportFailure } from '$lib/utils/transportFailure';
import { isAppOnScreen, onAppScreenChange } from '$lib/utils/appForeground';

/** Callback invoked when connectivity is regained (offline -> online). */
export type ReconnectListener = () => void;

/**
 * The `slow` state is DERIVED FROM WHAT ANSWERS ACTUALLY TOOK, not from a guess about the link
 * (WP-OFF-5), and it must measure THE LINK, not the server. Two readings feed it:
 *
 * - **The latency FLOOR of the last few answers.** The time to the response head of a call is
 *   link RTT plus server processing; processing only ever ADDS. So the smallest of the last
 *   {@link LATENCY_WINDOW} samples is the closest reading of the link, and one heavy feed, list or
 *   MLS call cannot lift it while any cheap call (a presence poll, the version probe) answers fast.
 *   The first version averaged every call (EWMA) and accused the link for server work: the Mi 9T
 *   bench phone showed the strip at a smoothed 784 ms with NOTHING in flight on a good link
 *   (2026-10-11). Measured on this estate, a good link answers a small GET in ~16 ms, the Slow 3G
 *   profile (400 ms RTT) in ~440 ms and the 2G-like profile (800 ms RTT) in ~960 ms (CDP,
 *   2026-10-09). Entered at 700 ms (between Slow 3G and the 2G-like profile), left at 350 ms: the
 *   gap is hysteresis, so a link hovering at the threshold does not make the hint flicker.
 * - **A request still unanswered after 5 s, while NOTHING ELSE answered meanwhile.** If any other
 *   call was answered since it started, the link is alive and the delay is that route's own server
 *   time, so it raises nothing. (No call in the app is a long poll or a stream - audited
 *   2026-10-11, the socket is separate - so a legitimately open request needs no exemption.)
 *
 * Neither can cause load, only a hint: if either were wrong, a small icon would be wrong.
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
/** How many recent answers the latency floor is taken over. */
const LATENCY_WINDOW = 5;
/** Samples needed before the floor may enter `slow` - one answer is not a link. */
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

/** Options of {@link ConnectivityStore.trackRequest}. */
export interface TrackRequestOptions {
  /** A body big enough that its time is mostly upload: never arms the in-flight hint. */
  transfer?: boolean;
}

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

  /** Floor of the recent time-to-response-head samples in ms, 0 until the first answer. Diagnostics and tests. */
  latencyMs = 0;
  private recent: number[] = [];
  private lastAnswerAt = 0;
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
  /**
   * A resume's probing stopped because the app left the screen, and is owed when it comes back.
   * DURABLE STATE, not a timer: the return to the screen is the event that settles it.
   */
  private probeOwedOnScreen = false;
  /**
   * Whether probing pauses while the app is off screen: the native mobile runtimes only, where the
   * OS pauses the app and starves its requests. A web or desktop tab in the background keeps its
   * network, and its probes keep restoring a link it may need. Set by `installReachabilityProbe`.
   */
  private probePausesOffScreen = false;
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
    // The probing a pause stopped resumes with the app, from its first attempt: what was learned
    // before the pause says nothing about the link now.
    onAppScreenChange((onScreen) => {
      if (!onScreen || !this.probeOwedOnScreen) return;
      this.probeOwedOnScreen = false;
      if (this.serverReachable || !this.isOnline) return;
      void this.probeUntilReachable(PROBE_DELAYS_AFTER_ONLINE_MS, 'app back on screen');
    });
  }

  /**
   * True when the BROWSER says there is no network at all (`navigator.onLine` false, kept by the
   * `online`/`offline` events). The one negative it gives is reliable - no interface, airplane
   * mode - and its return is announced by an `online` event, which re-runs every reconnect listener
   * and the probe. So a request that needs the server may be refused on this fact without being
   * sent: it could only fail, and the event that ends the condition is guaranteed to be heard.
   *
   * A NEGATIVE ONLY: `false` here proves nothing about reachability (captive portal, server down).
   * Measured on the Mi 9T, airplane mode, `v1.2.9-alpha.1` (2026-10-15): the cold start's refresh
   * failed and no failure probe ran, so `isOnline` was already false; the `online` event came when
   * the radio did.
   */
  browserReportsNoNetwork(): boolean {
    this.ensureGlobalListeners();
    return !this.isOnline;
  }

  /** Records that a request reached the server (whatever it answered). */
  notifyServerReachable(): void {
    this.ensureGlobalListeners();
    if (this.serverReachable && this.isOnline) return;
    console.log('[CONNECTIVITY] server reachable again');
    const wasOffline = this.isOffline;
    // A new count starts with the server back, whichever answer brought it back.
    this.consecutiveStalls = 0;
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

  /** Whether probing pauses off screen ({@link probePausesOffScreen}); the native mobile runtimes. */
  setProbePausesOffScreen(pauses: boolean): void {
    this.probePausesOffScreen = pauses;
  }

  /**
   * Probes the server until it answers, over a bounded number of attempts (see
   * {@link PROBE_DELAYS_AFTER_ONLINE_MS}). SINGLE-FLIGHT: a second trigger while one runs joins it
   * rather than starting another, so a flapping link cannot multiply probes. The answer itself is
   * recorded by the probe's own `trackedFetch` - `notifyServerReachable` fires reconnect listeners
   * (the outbox flush) exactly as any successful request would, with no second path.
   *
   * ON A PHONE, NEVER WHILE THE APP IS OFF SCREEN. A paused app's requests are the OS's to starve,
   * so a probe then measures the pause, not the link - and was seen probing on after the pause
   * (Android 1.5.3, 2026-10-31). The loop stops at the next attempt and is owed to the return to
   * the screen (`probeOwedOnScreen`), which starts it afresh. A web or desktop tab is not paused by
   * its OS and keeps probing ({@link probePausesOffScreen}).
   */
  private async probeUntilReachable(delaysMs: readonly number[], reason: string): Promise<void> {
    if (!this.probe || this.probing) return;
    this.probing = true;
    try {
      for (let attempt = 0; attempt < delaysMs.length; attempt++) {
        if (this.stopProbingOffScreen(reason)) return;
        const pause = delaysMs[attempt] * (0.75 + Math.random() * 0.5);
        if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
        // Someone else answered, or the link left again: nothing left to find out.
        if (this.serverReachable || !this.isOnline) return;
        if (this.stopProbingOffScreen(reason)) return;
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

  /** True (and the probing owed to the screen's return, said once) when the app is off screen. */
  private stopProbingOffScreen(reason: string): boolean {
    if (!this.probePausesOffScreen || isAppOnScreen()) return false;
    this.probeOwedOnScreen = true;
    console.log(
      `[CONNECTIVITY] app off screen - probing after ${reason} stops until it is back on screen`
    );
    return true;
  }

  /**
   * Starts counting a request that left the device. Every REST call goes through here (via
   * `trackedFetch`), so the store sees the whole population rather than the calls that happen to
   * be interesting. Settle the returned handle exactly once.
   */
  trackRequest(opts: TrackRequestOptions = {}): TrackedRequest {
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
          // Something else was answered since this one left: the link works, this route is just slow
          // server-side. Looked at again a threshold later, so a link that then goes quiet is caught.
          if (this.lastAnswerAt > startedAt) {
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
        this.lastAnswerAt = Date.now();
        this.notifyServerReachable();
        if (measured) this.observeLatency(Date.now() - startedAt);
        this.recomputeSlow();
      },
      failed: (error) => {
        if (!this.inFlight.has(id)) return;
        settle();
        if (error instanceof RequestDeadlineError) {
          // The count leads to ONE verdict, and once that verdict holds a stall is not a step
          // towards it: counting on read "3/2", "4/2" (2026-10-31). Said as what it is.
          if (!this.serverReachable) {
            console.warn(`[CONNECTIVITY] ${error.message} (server already unreachable)`);
          } else {
            this.consecutiveStalls++;
            console.warn(
              `[CONNECTIVITY] ${error.message} (stall ${this.consecutiveStalls}/${STALLS_BEFORE_UNREACHABLE})`
            );
            if (this.consecutiveStalls >= STALLS_BEFORE_UNREACHABLE) this.notifyServerUnreachable();
          }
        } else if (isTransportFailure(error)) {
          this.notifyServerUnreachable();
        }
        this.recomputeSlow();
      },
    };
  }

  /** Folds one answer's time-to-head into the window and re-reads the floor. */
  private observeLatency(ms: number): void {
    this.recent.push(ms);
    if (this.recent.length > LATENCY_WINDOW) this.recent.shift();
    this.latencyMs = Math.min(...this.recent);
    if (this.recent.length >= MIN_SAMPLES && this.latencyMs >= SLOW_ENTER_MS)
      this.latencySlow = true;
    else if (this.latencyMs <= SLOW_EXIT_MS) this.latencySlow = false;
  }

  /** Derives `slow` from its two readings; logged only on a change so a flapping link stays one line each way. */
  private recomputeSlow(): void {
    const next = !this.isOffline && (this.latencySlow || this.inFlightSlow);
    if (next === this.slow) return;
    this.slow = next;
    console.log(
      next
        ? `[CONNECTIVITY] slow link (latency floor ${Math.round(this.latencyMs)} ms, ${this.inFlight.size} request(s) in flight)`
        : `[CONNECTIVITY] link no longer slow (latency floor ${Math.round(this.latencyMs)} ms)`
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
    this.probeOwedOnScreen = false;
    this.probePausesOffScreen = false;
    for (const timer of this.inFlight.values()) clearTimeout(timer);
    this.inFlight.clear();
    this.slow = false;
    this.latencyMs = 0;
    this.recent = [];
    this.lastAnswerAt = 0;
    this.latencySlow = false;
    this.inFlightSlow = false;
    this.consecutiveStalls = 0;
  }
}

/** Singleton connectivity state. Read `connectivity.isOffline` in components. */
export const connectivity = new ConnectivityStore();
