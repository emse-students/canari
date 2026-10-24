import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectNativeSocket } from './nativeSocketConnect';

/**
 * CALL-WS-V6: the plugin's connect cannot be cancelled, so a socket that completes after the
 * deadline must be closed by this side, never left open and listened to by nobody. Fake timers
 * only - no wall clock.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const socket = () => ({ disconnect: vi.fn().mockResolvedValue(undefined) });

describe('connectNativeSocket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with a socket that connects in time and leaves it open', async () => {
    const d = deferred<ReturnType<typeof socket>>();
    const s = socket();
    const result = connectNativeSocket(d.promise, 15_000);
    d.resolve(s);
    await expect(result).resolves.toBe(s);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it('rejects at the deadline, then closes the socket that completes late', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deferred<ReturnType<typeof socket>>();
    const s = socket();
    const result = connectNativeSocket(d.promise, 15_000);
    const settled = expect(result).rejects.toThrow('WebSocket connection timeout after 15s');
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    expect(s.disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    d.resolve(s);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('past the 15000 ms deadline'));
    warn.mockRestore();
  });

  it('passes a failure inside the deadline through', async () => {
    const d = deferred<ReturnType<typeof socket>>();
    const result = connectNativeSocket(d.promise, 15_000);
    const settled = expect(result).rejects.toThrow('refused');
    d.reject(new Error('refused'));
    await settled;
  });

  it('logs a failure that arrives after the deadline instead of leaving it unhandled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deferred<ReturnType<typeof socket>>();
    const result = connectNativeSocket(d.promise, 15_000);
    const settled = expect(result).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    d.reject(new Error('refused late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(
      '[WS] abandoned native connect failed afterwards:',
      expect.any(Error)
    );
    warn.mockRestore();
  });
});
