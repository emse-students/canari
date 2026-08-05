import { connectivity, isTransportFailure } from './connectivity.svelte';

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
