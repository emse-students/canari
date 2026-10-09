import {
  PROBE_DELAYS_AFTER_ONLINE_MS,
  SLOW_ENTER_MS,
  SLOW_IN_FLIGHT_MS,
  connectivity,
  isTransportFailure,
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

describe('isTransportFailure', () => {
  it('recognises the bare TypeError fetch throws when it never reached the network', () => {
    expect(isTransportFailure(new TypeError('fetch failed'))).toBe(true);
  });

  it('recognises engine-specific transport wordings', () => {
    expect(isTransportFailure(new Error('Failed to fetch'))).toBe(true);
    expect(isTransportFailure(new Error('Load failed'))).toBe(true);
    expect(isTransportFailure(new Error('NetworkError when attempting to fetch'))).toBe(true);
  });

  it('does not treat a server answer as a connectivity problem', () => {
    // This is the distinction the whole offline flow rests on: an HTTP status means the server
    // was reached and has spoken, so it must never degrade the app to "offline".
    expect(isTransportFailure(new Error('Token refresh failed (HTTP 502)'))).toBe(false);
    expect(isTransportFailure(new Error('Unauthorized'))).toBe(false);
    expect(isTransportFailure('not an error')).toBe(false);
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

  it('enters slow once smoothed answers pass the threshold, not on one outlier', async () => {
    await answerAfter(100);
    await answerAfter(100);
    await answerAfter(1500);
    expect(connectivity.slow).toBe(false);
    for (let i = 0; i < 4; i++) await answerAfter(SLOW_ENTER_MS + 500);
    expect(connectivity.slow).toBe(true);
  });

  it('clears when answers come back quickly (hysteresis: not at the entry threshold)', async () => {
    for (let i = 0; i < 6; i++) await answerAfter(2500);
    expect(connectivity.slow).toBe(true);
    for (let i = 0; i < 12; i++) await answerAfter(100);
    expect(connectivity.slow).toBe(false);
  });

  it('a request unanswered past the in-flight threshold flags slow before any answer, and clears when it settles', async () => {
    const r = connectivity.trackRequest();
    await vi.advanceTimersByTimeAsync(SLOW_IN_FLIGHT_MS + 10);
    expect(connectivity.slow).toBe(true);
    r.answered(false);
    expect(connectivity.slow).toBe(false);
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

  it('does not probe into a link the browser itself reports dead', async () => {
    const probe = vi.fn(async () => true);
    connectivity.setReachabilityProbe(probe);
    window.dispatchEvent(new Event('offline'));
    connectivity.notifyServerUnreachable();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).not.toHaveBeenCalled();
  });
});
