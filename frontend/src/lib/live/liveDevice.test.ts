/**
 * THE SCREEN LOCK OF A LIVE against a fake `navigator.wakeLock` whose requests the test answers by
 * hand: whatever the order of holds, releases and answers, at most one lock is held, and none is
 * left held after the last release.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenWakeLock, type WakeLockApi } from './liveDevice';

class FakeSentinel {
  released = false;
  release = vi.fn(async () => {
    this.released = true;
  });
}

/** A wake lock API whose requests stay pending until the test answers them, in any order. */
function fakeApi() {
  const pending: ((s: FakeSentinel) => void)[] = [];
  const sentinels: FakeSentinel[] = [];
  const api: WakeLockApi = {
    request: vi.fn(
      () =>
        new Promise<FakeSentinel>((resolve) => {
          pending.push(resolve);
        })
    ),
  };
  /** Answers the `i`-th request with a fresh sentinel. */
  const answer = (i: number) => {
    const s = new FakeSentinel();
    sentinels.push(s);
    pending[i](s);
    return s;
  };
  const held = () => sentinels.filter((s) => !s.released);
  return { api, answer, held };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ScreenWakeLock', () => {
  it('hold, release, hold while the FIRST request is in flight: the first answer is given back, the second kept', async () => {
    const { api, answer, held } = fakeApi();
    const lock = new ScreenWakeLock(api);
    const first = lock.hold();
    lock.release();
    const second = lock.hold();
    const s1 = answer(0);
    const s2 = answer(1);
    await first;
    await second;
    await settle();
    expect(s1.released).toBe(true);
    expect(held()).toEqual([s2]);
    lock.release();
    await settle();
    expect(held()).toEqual([]);
  });

  it('the answers arriving in the opposite order end the same way', async () => {
    const { api, answer, held } = fakeApi();
    const lock = new ScreenWakeLock(api);
    const first = lock.hold();
    lock.release();
    const second = lock.hold();
    const s2 = answer(1);
    await second;
    const s1 = answer(0);
    await first;
    await settle();
    expect(s1.released).toBe(true);
    expect(held()).toEqual([s2]);
  });

  it('a release while the only request is in flight leaves nothing held', async () => {
    const { api, answer, held } = fakeApi();
    const lock = new ScreenWakeLock(api);
    const first = lock.hold();
    lock.release();
    answer(0);
    await first;
    await settle();
    expect(held()).toEqual([]);
  });

  it('holding again while a lock stands asks for nothing', async () => {
    const { api, answer } = fakeApi();
    const lock = new ScreenWakeLock(api);
    const first = lock.hold();
    answer(0);
    await first;
    await lock.hold();
    expect(api.request).toHaveBeenCalledTimes(1);
  });
});
