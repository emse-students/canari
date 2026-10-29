/**
 * THE SCREEN LOCK OF A LIVE against a fake `navigator.wakeLock` whose requests the test answers by
 * hand: whatever the order of holds, releases and answers, at most one lock is held, and none is
 * left held after the last release.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraAccessError } from '$lib/reels/cameraAccess';
import { ScreenWakeLock, openLiveCamera, type WakeLockApi } from './liveDevice';

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
  vi.unstubAllGlobals();
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

  it('a hold superseded by one that was REFUSED still keeps the lock it got', async () => {
    const api0 = fakeApi();
    const reject: ((e: Error) => void)[] = [];
    let call = 0;
    const api: WakeLockApi = {
      request: vi.fn(() => {
        const i = call++;
        if (i === 1) return new Promise<never>((_, rej) => reject.push(rej));
        return api0.api.request('screen');
      }),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lock = new ScreenWakeLock(api);
    const a = lock.hold();
    const b = lock.hold();
    reject[0](new Error('hidden'));
    await b;
    const sentinel = api0.answer(0);
    await a;
    await settle();
    expect(sentinel.released).toBe(false);
    expect(api0.held()).toEqual([sentinel]);
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

/** The primary pointer: a finger on a phone (`coarse`), a mouse on a desktop. */
function pointer(coarse: boolean): void {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: coarse }) });
}

/** The `facingMode` the first `getUserMedia` call asked for. */
function askedFacing(gum: { mock: { calls: unknown[][] } }): unknown {
  return ((gum.mock.calls[0]![0] as MediaStreamConstraints).video as MediaTrackConstraints)
    .facingMode;
}

/** A `getUserMedia` answering like a DESKTOP webcam: no facing, so an exact one is overconstrained. */
function desktopWebcam() {
  return vi.fn(async (c: MediaStreamConstraints) => {
    const fm = (c.video as MediaTrackConstraints).facingMode as { exact?: string } | undefined;
    if (fm?.exact) throw new DOMException('x', 'OverconstrainedError');
    return { getVideoTracks: () => [{ getSettings: () => ({}) }] };
  });
}

describe('openLiveCamera lens constraint', () => {
  it('DESKTOP: the first capture is IDEAL, so a webcam with no facing opens', async () => {
    pointer(false);
    const getUserMedia = desktopWebcam();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await expect(openLiveCamera('user')).resolves.toBeDefined();
    expect(askedFacing(getUserMedia)).toEqual({ ideal: 'user' });
  });

  it('PHONE: the first capture is EXACT, as the reel camera asks it', async () => {
    pointer(true);
    const getUserMedia = vi.fn().mockResolvedValue({ getVideoTracks: () => [] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await openLiveCamera('user');
    expect(getUserMedia.mock.calls[0][0].video.facingMode).toEqual({ exact: 'user' });
  });

  it('an explicit switch is EXACT, and a lens the device lacks is a typed unavailable', async () => {
    pointer(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getUserMedia = desktopWebcam();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const err = await openLiveCamera('environment', true).catch((e: unknown) => e);
    expect(askedFacing(getUserMedia)).toEqual({ exact: 'environment' });
    expect(err).toBeInstanceOf(CameraAccessError);
    expect((err as CameraAccessError).fault).toBe('unavailable');
  });
});
