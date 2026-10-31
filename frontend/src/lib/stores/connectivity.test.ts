// @vitest-environment happy-dom
import {
  PROBE_DELAYS_AFTER_ONLINE_MS,
  SLOW_ENTER_MS,
  SLOW_IN_FLIGHT_MS,
  connectivity,
} from './connectivity.svelte';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';

describe('connectivity store', () => {
  beforeEach(() => {
    connectivity.reset();
  });

  it('is online until something proves otherwise', () => {
    expect(connectivity.isOffline).toBe(false);
  });

  it('reports offline when the server cannot be reached, even though the browser claims a link', () => {
    // The exact case navigator.onLine gets wrong: a captive portal, or a backend that is down.
    expect(connectivity.isOnline).toBe(true);
    connectivity.notifyServerUnreachable();
    expect(connectivity.isOnline).toBe(true);
    expect(connectivity.isOffline).toBe(true);
  });

  it('clears the offline state on the first request that reaches the server', () => {
    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();
    expect(connectivity.isOffline).toBe(false);
  });

  it('notifies reconnect listeners exactly once when connectivity is regained', () => {
    const listener = vi.fn();
    connectivity.onReconnect(listener);

    connectivity.notifyServerUnreachable();
    expect(listener).not.toHaveBeenCalled();

    connectivity.notifyServerReachable();
    expect(listener).toHaveBeenCalledTimes(1);

    // Already online: a second success is not a reconnection and must not re-fire the sequence.
    connectivity.notifyServerReachable();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps running the other listeners when one throws', () => {
    const good = vi.fn();
    connectivity.onReconnect(() => {
      throw new Error('boom');
    });
    connectivity.onReconnect(good);

    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();

    expect(good).toHaveBeenCalledTimes(1);
  });

  it('stops notifying an unsubscribed listener', () => {
    const listener = vi.fn();
    const off = connectivity.onReconnect(listener);
    off();

    connectivity.notifyServerUnreachable();
    connectivity.notifyServerReachable();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the slow state is derived from observed answers, and never stacks on offline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectivity.reset();
  });
  afterEach(() => vi.useRealTimers());

  /** One request that takes `ms` to answer. */
  async function answerAfter(ms: number): Promise<void> {
    const r = connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(ms);
    r.answered();
  }

  it('is not slow on a good link', async () => {
    for (let i = 0; i < 6; i++) await answerAfter(100);
    expect(connectivity.slow).toBe(false);
  });

  it('enters slow once the FLOOR of recent answers passes the threshold, not on outliers', async () => {
    await answerAfter(100);
    await answerAfter(SLOW_ENTER_MS * 3);
    await answerAfter(SLOW_ENTER_MS * 3);
    // Heavy server-side calls lift the average, never the floor while one cheap call answers fast.
    expect(connectivity.latencyMs).toBe(100);
    expect(connectivity.slow).toBe(false);
    for (let i = 0; i < 5; i++) await answerAfter(SLOW_ENTER_MS + 500);
    expect(connectivity.slow).toBe(true);
  });

  it('heavy routes interleaved with cheap ones never accuse the link (the Mi 9T 784 ms case)', async () => {
    for (let i = 0; i < 20; i++) {
      await answerAfter(1200);
      await answerAfter(1200);
      await answerAfter(40);
    }
    expect(connectivity.slow).toBe(false);
  });

  it('clears when answers come back quickly (hysteresis: not at the entry threshold)', async () => {
    for (let i = 0; i < 6; i++) await answerAfter(2500);
    expect(connectivity.slow).toBe(true);
    for (let i = 0; i < 6; i++) await answerAfter(100);
    expect(connectivity.slow).toBe(false);
  });

  it('a request unanswered past the in-flight threshold flags slow before any answer, and clears when it settles', async () => {
    const r = connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    expect(connectivity.slow).toBe(true);
    r.answered(false);
    expect(connectivity.slow).toBe(false);
  });

  it('a slow route does not accuse the link while other calls are being answered', async () => {
    const heavy = connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(2_000);
    connectivity.trackRequest().answered();
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS * 3);
    expect(connectivity.slow).toBe(false);
    heavy.answered(false);
  });

  it('a transfer (a body mostly upload time) never arms the in-flight hint, yet still settles cleanly', async () => {
    const r = connectivity.trackRequest({ transfer: true });
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS * 3);
    expect(connectivity.slow).toBe(false);
    r.answered(false);
    expect(connectivity.slow).toBe(false);
  });

  it('a timer that fired far behind its schedule blames the device, not the link', async () => {
    const r = connectivity.trackRequest();
    // The renderer thread was busy: the wall clock ran ahead of the timer by seconds.
    vi.setSystemTime(Date.now() + 4_000);
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    expect(connectivity.slow).toBe(false);
    // Still unanswered a full threshold later: the link, not the device, is now the suspect.
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    expect(connectivity.slow).toBe(true);
    r.answered(false);
  });

  it('is never slow while offline: the two hints do not stack', async () => {
    const r = connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    expect(connectivity.slow).toBe(true);
    connectivity.notifyServerUnreachable();
    expect(connectivity.slow).toBe(false);
    r.failed(new TypeError('Failed to fetch'));
    expect(connectivity.slow).toBe(false);
  });

  it('one deadline expiry is a stall, two in a row are unreachable, an answer resets the count', () => {
    const stall = () =>
      connectivity.trackRequest().failed(new RequestDeadlineError('read', 20000, 'GET', '/a', 0));
    stall();
    expect(connectivity.isOffline).toBe(false);
    connectivity.trackRequest().answered();
    stall();
    expect(connectivity.isOffline).toBe(false);
    stall();
    expect(connectivity.isOffline).toBe(true);
  });

  // Read on Android 1.5.3 (2026-10-31): "(stall 3/2)", "(stall 4/2)" - a count past its own limit.
  it('never counts past its limit: a stall once unreachable is said as such, and the count restarts with the server', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stall = () =>
      connectivity.trackRequest().failed(new RequestDeadlineError('read', 20000, 'GET', '/a', 0));
    for (let i = 0; i < 5; i++) stall();
    expect(connectivity.isOffline).toBe(true);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('(stall 1/2)'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('(stall 2/2)'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('(server already unreachable)'))).toHaveLength(3);
    expect(lines.some((l) => /stall [3-9]\/2/.test(l))).toBe(false);
    // Back by an answer that did not go through `trackRequest` (a socket): a fresh count of two.
    connectivity.notifyServerReachable();
    stall();
    expect(connectivity.isOffline).toBe(false);
    stall();
    expect(connectivity.isOffline).toBe(true);
    warn.mockRestore();
  });

  it('a cancellation is neither a stall nor a transport failure', () => {
    for (let i = 0; i < 4; i++)
      connectivity.trackRequest().failed(new DOMException('aborted', 'AbortError'));
    expect(connectivity.isOffline).toBe(false);
  });
});

describe('prompt resume: the store asks the server instead of waiting to be told (WP-OFF-6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectivity.reset();
    // Installs the window listeners; `reset` clears everything but them.
    connectivity.notifyServerReachable();
  });
  afterEach(() => vi.useRealTimers());

  const online = () => window.dispatchEvent(new Event('online'));

  it('on `online` while unreachable, probes AT ONCE and fires reconnect listeners when it answers', async () => {
    const probe = vi.fn(async () => {
      connectivity.notifyServerReachable();
      return true;
    });
    connectivity.setReachabilityProbe(probe);
    const listener = vi.fn();
    connectivity.onReconnect(listener);
    connectivity.notifyServerUnreachable();
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(10_000);
    probe.mockClear();
    listener.mockClear();

    online();
    await vi.advanceTimersByTimeAsync(0);
    // The `online` handler runs the listeners once (the gate may refuse them, the server not yet
    // known reachable); the probe, sent in the same breath, is what makes the SECOND, accepted one -
    // no unrelated request needed.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(connectivity.isOffline).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('is bounded: a server that never answers gets exactly the planned probes, then silence', async () => {
    const probe = vi.fn(async () => false);
    connectivity.setReachabilityProbe(probe);
    connectivity.notifyServerUnreachable();
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(60_000);
    probe.mockClear();

    online();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).toHaveBeenCalledTimes(PROBE_DELAYS_AFTER_ONLINE_MS.length);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probe).toHaveBeenCalledTimes(PROBE_DELAYS_AFTER_ONLINE_MS.length);
  });

  it('is single-flight: a flapping link joins the running probe instead of starting another', async () => {
    const probe = vi.fn(async () => false);
    connectivity.setReachabilityProbe(probe);
    connectivity.notifyServerUnreachable();
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(60_000);
    probe.mockClear();

    online();
    online();
    online();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).toHaveBeenCalledTimes(PROBE_DELAYS_AFTER_ONLINE_MS.length);
  });

  it('stops asking as soon as something else answered', async () => {
    const probe = vi.fn(async () => false);
    connectivity.setReachabilityProbe(probe);
    connectivity.notifyServerUnreachable();
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(60_000);
    probe.mockClear();

    online();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    connectivity.notifyServerReachable();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a transport failure with the browser still online starts a probe after a pause, never immediately', async () => {
    const probe = vi.fn(async () => {
      connectivity.notifyServerReachable();
      return true;
    });
    connectivity.setReachabilityProbe(probe);
    connectivity.notifyServerUnreachable();
    await vi.advanceTimersByTimeAsync(500);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(connectivity.isOffline).toBe(false);
  });

  /** The Android activity's foreground flag and event (`utils/appForeground.ts`). */
  const setForeground = (foreground: boolean) => {
    (window as unknown as Record<string, unknown>).__canariForeground = foreground;
    window.dispatchEvent(new CustomEvent('canari:foreground', { detail: { foreground } }));
  };

  // Android 1.5.3 (2026-10-31): probes kept leaving after the app paused.
  it('never probes while the app is off screen, and probes afresh when it comes back', async () => {
    try {
      const probe = vi.fn(async () => false);
      connectivity.setReachabilityProbe(probe);
      setForeground(false);
      connectivity.notifyServerUnreachable();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(probe).not.toHaveBeenCalled();

      probe.mockImplementation(async () => {
        connectivity.notifyServerReachable();
        return true;
      });
      setForeground(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(connectivity.isOffline).toBe(false);
    } finally {
      delete (window as unknown as Record<string, unknown>).__canariForeground;
    }
  });

  it('stops a resume already probing when the app leaves the screen', async () => {
    try {
      const probe = vi.fn(async () => false);
      connectivity.setReachabilityProbe(probe);
      connectivity.notifyServerUnreachable();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(probe).toHaveBeenCalledTimes(1);
      setForeground(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(probe).toHaveBeenCalledTimes(1);
      // Back on screen with the server found meanwhile: nothing is owed any more.
      connectivity.notifyServerReachable();
      setForeground(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as Record<string, unknown>).__canariForeground;
    }
  });

  it('does not probe into a link the browser itself reports dead', async () => {
    const probe = vi.fn(async () => true);
    connectivity.setReachabilityProbe(probe);
    window.dispatchEvent(new Event('offline'));
    connectivity.notifyServerUnreachable();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).not.toHaveBeenCalled();
  });
});
