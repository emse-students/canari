// @vitest-environment happy-dom
/**
 * The camera session gives back what an acquisition RETURNS, even when the acquisition finishes after
 * the member has moved on (left the tab, switched lens, backgrounded the app). Pinned by ordering,
 * never by a clock: each test resolves the opener's promises in the order it wants.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAMERA_LENS_KEY } from './cameraLens';
import { CameraSession } from './cameraSession.svelte';
import { CameraAccessError, type CameraFacing } from './cameraAccess';
import { giveMediaStreamGetTracks } from './mediaStreamTracks.test-helper';

giveMediaStreamGetTracks();

function fakeStream(torch = false) {
  const stop = vi.fn();
  const video = {
    stop,
    getCapabilities: () => (torch ? { torch: true } : {}),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  };
  const stream = {
    getTracks: () => [video],
    getVideoTracks: () => [video],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
  return { stream, stop, video };
}

/** An opener whose calls resolve only when the test says so. */
function deferredOpener() {
  const calls: {
    facing: CameraFacing;
    switching: boolean | undefined;
    resolve: (s: MediaStream) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const open = (facing: CameraFacing, switching?: boolean) =>
    new Promise<MediaStream>((resolve, reject) =>
      calls.push({ facing, switching, resolve, reject })
    );
  return { open, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('CameraSession lens request', () => {
  it('the first open is not a switch, the flip button is', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    void session.start();
    expect(calls[0].switching).toBe(false);
    void session.switchFacing();
    expect(calls[1]).toMatchObject({ facing: 'environment', switching: true });
  });
});

describe('CameraSession', () => {
  it('starts on the FRONT lens, then is live with the stream', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    expect(session.phase).toBe('starting');
    expect(calls[0].facing).toBe('user');

    const { stream } = fakeStream(true);
    calls[0].resolve(stream);
    await started;
    expect(session.phase).toBe('live');
    expect(session.stream).toBe(stream);
    expect(session.torchAvailable).toBe(true);
  });

  it('releases a stream that arrives after the session was stopped', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    session.stop();

    const late = fakeStream();
    calls[0].resolve(late.stream);
    await started;
    expect(late.stop).toHaveBeenCalled();
    expect(session.stream).toBeNull();
    expect(session.phase).toBe('stopped');
  });

  it('the permission dialog backgrounding the app does not ask a second time: a refusal is shown once (Mi 9T, v1.2.9-alpha.1)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    // Android's dialog hides the WebView while it asks, and shows it again when answered.
    session.suspend();
    calls[0].reject(new CameraAccessError('denied', 'denied'));
    await started;
    session.resume();
    expect(calls).toHaveLength(1);
    expect(session.phase).toBe('error');
    expect(session.fault).toBe('denied');
  });

  it('an open that FAILS while the app is away (not refused) is opened again on the return', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    session.suspend();
    calls[0].reject(new CameraAccessError('busy', 'busy'));
    await started;
    expect(session.phase).toBe('stopped');

    session.resume();
    expect(calls).toHaveLength(2);
    expect(session.phase).toBe('starting');
  });

  it('an open granted while the app is away is released, and the return opens it again', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    session.suspend();
    const away = fakeStream();
    calls[0].resolve(away.stream);
    await started;
    expect(away.stop).toHaveBeenCalled();
    expect(session.phase).toBe('stopped');

    session.resume();
    expect(calls).toHaveLength(2);
    expect(session.phase).toBe('starting');
  });

  it('an open granted after the return is installed, never asked again', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    session.suspend();
    session.resume();
    const { stream } = fakeStream();
    calls[0].resolve(stream);
    await started;
    expect(calls).toHaveLength(1);
    expect(session.phase).toBe('live');
    expect(session.stream).toBe(stream);
  });

  it('keeps only the LAST lens when two opens overlap, and releases the first', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const first = session.start('environment');
    const second = session.switchFacing(); // environment -> user

    const back = fakeStream();
    const front = fakeStream();
    calls[1].resolve(front.stream);
    await second;
    calls[0].resolve(back.stream);
    await first;

    expect(session.facing).toBe('user');
    expect(session.stream).toBe(front.stream);
    expect(back.stop).toHaveBeenCalled();
    expect(front.stop).not.toHaveBeenCalled();
  });

  it('switching lens releases the open one before asking for the other', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    const back = fakeStream(); // the front lens here, the first one opened
    calls[0].resolve(back.stream);
    await started;

    void session.switchFacing();
    expect(back.stop).toHaveBeenCalled();
    expect(calls[1].facing).toBe('environment');
  });

  it('turns a typed refusal into the fault the screen draws', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    calls[0].reject(new CameraAccessError('busy', 'camera: busy'));
    await started;
    expect(session.phase).toBe('error');
    expect(session.fault).toBe('busy');
  });

  it('lights the torch only through the track, and stays dark when the track refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    const { stream, video } = fakeStream(true);
    calls[0].resolve(stream);
    await started;

    await session.toggleTorch();
    expect(video.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    expect(session.torchOn).toBe(true);

    video.applyConstraints.mockRejectedValueOnce(new Error('no'));
    await session.toggleTorch();
    expect(session.torchOn).toBe(true);
  });

  it('leaves `live` when the OS ends the lens under it, and an ended stale lens changes nothing', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const listeners: (() => void)[] = [];
    const signals: AbortSignal[] = [];
    const first = fakeStream();
    Object.assign(first.video, {
      addEventListener: (type: string, fn: () => void, opts: { signal: AbortSignal }) => {
        if (type !== 'ended') return;
        listeners.push(fn);
        signals.push(opts.signal);
      },
    });
    const started = session.start();
    calls[0].resolve(first.stream);
    await started;
    expect(session.phase).toBe('live');

    // Another app takes the camera (or the permission goes): the track ends. Which of the two is not
    // known, so the fault says "interrupted", never "busy".
    listeners[0]();
    expect(session.phase).toBe('error');
    expect(session.fault).toBe('interrupted');
    // Its listener is removed with the release.
    expect(signals[0].aborted).toBe(true);
    expect(session.stream).toBeNull();
    expect(first.stop).toHaveBeenCalled();

    // A retry opens a new lens; the OLD track's end, arriving late, must not take it down.
    const second = fakeStream();
    const retried = session.start();
    calls[1].resolve(second.stream);
    await retried;
    listeners[0]();
    expect(session.phase).toBe('live');
    expect(session.stream).toBe(second.stream);
  });

  it('a microphone that ends mid-session is no longer counted: the session films no more', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const { stream, video } = fakeStream();
    let micEnded: () => void = () => {};
    const mic = {
      kind: 'audio',
      readyState: 'live',
      stop: vi.fn(),
      addEventListener: (type: string, fn: () => void) => type === 'ended' && (micEnded = fn),
    };
    Object.assign(stream, { getAudioTracks: () => [mic], getTracks: () => [video, mic] });
    const started = session.start();
    calls[0].resolve(stream);
    await started;
    expect(session.microphone).toBe(true);

    micEnded();

    expect(session.microphone).toBe(false);
    expect(session.phase).toBe('live');
  });
});

/** A lens track and a microphone track, real enough for `new MediaStream([...])`. */
function lensTrack(caps: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  return {
    kind: 'video',
    readyState: 'live',
    stop: vi.fn(),
    getCapabilities: () => caps,
    getSettings: () => settings,
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
  };
}
function micTrack() {
  return { kind: 'audio', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn() };
}
function streamOf(...tracks: { kind: string }[]): MediaStream {
  return new MediaStream(tracks as unknown as MediaStreamTrack[]);
}

describe('CameraSession - a lens flip DURING A TAKE (user, 2026-10-22)', () => {
  async function liveTake() {
    const lens = deferredOpener();
    const front = lensTrack();
    const mic = micTrack();
    const session = new CameraSession(() => Promise.resolve(streamOf(front, mic)), lens.open);
    await session.start();
    return { session, lens, front, mic };
  }

  it('replaces the LENS only: the microphone is never stopped and joins the new stream', async () => {
    const { session, lens, front, mic } = await liveTake();
    const flipped = session.flipDuringTake();
    // The old lens is given back BEFORE the other one is asked for: a phone opens one at a time.
    expect(front.stop).toHaveBeenCalled();
    expect(lens.calls[0].facing).toBe('environment');
    // The phase stays live, so the shutter under the member's finger is never unmounted.
    expect(session.phase).toBe('live');
    expect(session.flipping).toBe(true);

    const back = lensTrack();
    lens.calls[0].resolve(streamOf(back));
    await flipped;

    expect(session.flipping).toBe(false);
    expect(session.facing).toBe('environment');
    expect(session.stream!.getVideoTracks()).toEqual([back]);
    expect(session.stream!.getAudioTracks()).toEqual([mic]);
    expect(mic.stop).not.toHaveBeenCalled();
    expect(session.microphone).toBe(true);
  });

  it('a lens that will not open ends the session in its fault - the old lens is not reopened behind the member', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { session, lens, mic } = await liveTake();
    const flipped = session.flipDuringTake();
    lens.calls[0].reject(new CameraAccessError('busy', 'busy'));
    await flipped;
    expect(session.phase).toBe('error');
    expect(session.fault).toBe('busy');
    expect(session.flipping).toBe(false);
    // The take is over with the session: its microphone goes back too.
    expect(mic.stop).toHaveBeenCalled();
    expect(lens.calls).toHaveLength(1);
  });

  it('a lens arriving after the session stopped is given back, with nothing installed', async () => {
    const { session, lens, mic } = await liveTake();
    const flipped = session.flipDuringTake();
    session.stop();
    expect(mic.stop).toHaveBeenCalled();
    const late = lensTrack();
    lens.calls[0].resolve(streamOf(late));
    await flipped;
    expect(late.stop).toHaveBeenCalled();
    expect(session.stream).toBeNull();
    expect(session.phase).toBe('stopped');
  });

  it('a second flip asked while one is in flight is ignored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { session, lens } = await liveTake();
    void session.flipDuringTake();
    await session.flipDuringTake();
    expect(lens.calls).toHaveLength(1);
  });
});

describe('CameraSession - zoom (user, 2026-10-22)', () => {
  it('a lens with no zoom capability zooms DIGITALLY; the level is clamped and rests at 1x on a flip', async () => {
    const lens = deferredOpener();
    const session = new CameraSession(
      () => Promise.resolve(streamOf(lensTrack(), micTrack())),
      lens.open
    );
    await session.start();
    expect(session.zoomRange.mode).toBe('digital');
    session.setZoom(3);
    expect(session.zoom).toBe(3);
    session.setZoom(9);
    expect(session.zoom).toBe(5);

    const flipped = session.flipDuringTake();
    lens.calls[0].resolve(streamOf(lensTrack()));
    await flipped;
    expect(session.zoom).toBe(1);

    session.setZoom(2);
    session.resetZoom();
    expect(session.zoom).toBe(1);
  });

  it('a lens WITH a zoom capability is zoomed through its track, one request at a time, the latest level winning', async () => {
    const track = lensTrack({ zoom: { min: 1, max: 8 } }, { zoom: 1 });
    let finish: () => void = () => {};
    track.applyConstraints.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const session = new CameraSession(() => Promise.resolve(streamOf(track)));
    await session.start();
    expect(session.zoomRange).toEqual({ mode: 'hardware', min: 1, max: 8 });

    session.setZoom(2);
    session.setZoom(3);
    session.setZoom(4);
    expect(track.applyConstraints).toHaveBeenCalledTimes(1);
    expect(track.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ zoom: 2 }] });
    finish();
    await Promise.resolve();
    await Promise.resolve();
    // The two levels asked meanwhile collapse into the last one.
    expect(track.applyConstraints).toHaveBeenCalledTimes(2);
    expect(track.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ zoom: 4 }] });
    expect(session.zoom).toBe(4);
  });

  it('a lens that refuses its own zoom says so once, and shows its real level', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const track = lensTrack({ zoom: { min: 1, max: 8 } }, { zoom: 1 });
    track.applyConstraints.mockRejectedValue(new Error('OverconstrainedError'));
    const session = new CameraSession(() => Promise.resolve(streamOf(track)));
    await session.start();
    session.setZoom(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.zoom).toBe(1);
    session.setZoom(5);
    expect(track.applyConstraints).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a zoom request the FLIP cut short is no refusal: nothing is accused, and the new lens still zooms', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const front = lensTrack({ zoom: { min: 1, max: 8 } }, { zoom: 6 });
    let refuse: (err: Error) => void = () => {};
    front.applyConstraints.mockImplementation(
      () => new Promise<void>((_resolve, reject) => (refuse = reject))
    );
    const lens = deferredOpener();
    const session = new CameraSession(
      () => Promise.resolve(streamOf(front, micTrack())),
      lens.open
    );
    await session.start();
    session.setZoom(3);
    expect(front.applyConstraints).toHaveBeenCalledTimes(1);

    const flipped = session.flipDuringTake();
    const back = lensTrack({ zoom: { min: 1, max: 10 } }, { zoom: 1 });
    lens.calls[0].resolve(streamOf(back));
    await flipped;
    // The stopped lens rejects the request it was still running.
    refuse(new Error('the track ended'));
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(error).not.toHaveBeenCalled();
    // The level is the new lens's resting one, never the dead track's 6x.
    expect(session.zoom).toBe(1);
    session.setZoom(4);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(back.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ zoom: 4 }] });
    expect(session.zoom).toBe(4);
  });

  it('the mode is logged ONCE per session at info, never per gesture or per reopen', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const session = new CameraSession(() => Promise.resolve(streamOf(lensTrack())));
    await session.start();
    for (let level = 1; level <= 5; level += 0.5) session.setZoom(level);
    await session.switchFacing();
    await session.switchFacing();
    const zoomLines = info.mock.calls.filter((c) => String(c[0]).includes('zoom is'));
    expect(zoomLines).toHaveLength(1);
    expect(String(zoomLines[0][0])).toContain('digital');
  });
});

describe('CameraSession - the switch needs a second camera (owner, 2026-10-31)', () => {
  it('offers no switch with one camera, and offers it from two', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open, open, async () => 1);
    // Before any read the count is unknown, and unknown keeps the switch (fails open).
    expect(session.cameraCount).toBeNull();
    expect(session.canSwitch).toBe(true);
    void session.start();
    calls[0].resolve(fakeStream().stream);
    await vi.waitFor(() => expect(session.phase).toBe('live'));
    await vi.waitFor(() => expect(session.cameraCount).toBe(1));
    expect(session.canSwitch).toBe(false);

    const two = new CameraSession(open, open, async () => 2);
    void two.start();
    calls[1].resolve(fakeStream().stream);
    await vi.waitFor(() => expect(two.canSwitch).toBe(true));
  });

  it('recounts on devicechange while open, and stops listening once stopped', async () => {
    const { open, calls } = deferredOpener();
    const target = new EventTarget();
    vi.stubGlobal('navigator', { mediaDevices: target });
    let count = 1;
    const session = new CameraSession(open, open, async () => count);
    void session.start();
    calls[0].resolve(fakeStream().stream);
    await vi.waitFor(() => expect(session.phase).toBe('live'));
    await vi.waitFor(() => expect(session.cameraCount).toBe(1));

    count = 2;
    target.dispatchEvent(new Event('devicechange'));
    await vi.waitFor(() => expect(session.canSwitch).toBe(true));

    session.stop();
    count = 1;
    target.dispatchEvent(new Event('devicechange'));
    await Promise.resolve();
    // Stopped: the count is forgotten (null), and the later devicechange (to 1) was not heard.
    expect(session.cameraCount).toBeNull();
    vi.unstubAllGlobals();
  });

  it('KEEPS the switch when the device list cannot be read (fails open)', async () => {
    const { open, calls } = deferredOpener();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = new CameraSession(open, open, async () => {
      throw new Error('no list');
    });
    void session.start();
    calls[0].resolve(fakeStream().stream);
    await vi.waitFor(() => expect(session.phase).toBe('live'));
    await Promise.resolve();
    expect(session.cameraCount).toBeNull();
    expect(session.canSwitch).toBe(true);
  });

  it('keeps the switch on a list that told nothing (0 videoinput) and logs the count it read', async () => {
    const { open, calls } = deferredOpener();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const session = new CameraSession(open, open, async () => 0);
    void session.start();
    calls[0].resolve(fakeStream().stream);
    await vi.waitFor(() =>
      expect(info.mock.calls.some((c) => String(c[0]).includes('[CAMERA_COUNT]'))).toBe(true)
    );
    expect(session.cameraCount).toBeNull();
    expect(session.canSwitch).toBe(true);
    expect(
      String(info.mock.calls.find((c) => String(c[0]).includes('[CAMERA_COUNT]'))![0])
    ).toContain('videoinput=0');
  });

  it('a count read that lands AFTER stop() writes nothing', async () => {
    const { open, calls } = deferredOpener();
    let release: (n: number) => void = () => {};
    const session = new CameraSession(open, open, () => new Promise<number>((r) => (release = r)));
    void session.start();
    calls[0].resolve(fakeStream().stream);
    await vi.waitFor(() => expect(session.phase).toBe('live'));
    session.stop();
    release(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.cameraCount).toBeNull();
  });
});

describe('CameraSession lens memory', () => {
  function withFacing(facingMode: string | undefined) {
    const made = fakeStream();
    (made.video as Record<string, unknown>).getSettings = () => ({ facingMode });
    return made;
  }

  it('opens on the remembered lens, for any session of any camera', async () => {
    localStorage.setItem(CAMERA_LENS_KEY, 'environment');
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    void session.start();
    expect(calls[0]).toMatchObject({ facing: 'environment', switching: false });
    calls[0].resolve(withFacing('environment').stream);
    await vi.waitFor(() => expect(session.phase).toBe('live'));
    expect(session.facing).toBe('environment');
  });

  it('opens on the front lens when the stored value is no lens', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(CAMERA_LENS_KEY, 'wide');
    const { open, calls } = deferredOpener();
    void new CameraSession(open).start();
    expect(calls[0].facing).toBe('user');
  });

  it('saves the lens when the member flips it, outside and during a take', async () => {
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open, open);
    void session.start();
    calls[0].resolve(fakeStream().stream);
    await vi.waitFor(() => expect(session.phase).toBe('live'));

    void session.switchFacing();
    expect(localStorage.getItem(CAMERA_LENS_KEY)).toBe('environment');
    calls[1].resolve(fakeStream().stream);
    await vi.waitFor(() => expect(session.phase).toBe('live'));

    const flipped = session.flipDuringTake();
    expect(localStorage.getItem(CAMERA_LENS_KEY)).toBe('user');
    calls[2].resolve(fakeStream().stream);
    await flipped;
  });

  it('a camera built after a flip opens on the flipped lens', async () => {
    const first = deferredOpener();
    const a = new CameraSession(first.open);
    void a.start();
    first.calls[0].resolve(fakeStream().stream);
    await vi.waitFor(() => expect(a.phase).toBe('live'));
    void a.switchFacing();

    const second = deferredOpener();
    void new CameraSession(second.open).start();
    expect(second.calls[0].facing).toBe('environment');
  });

  it('opens the available lens when the remembered one is unavailable, and keeps the memory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(CAMERA_LENS_KEY, 'environment');
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    calls[0].reject(new CameraAccessError('unavailable', 'no rear camera'));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].facing).toBe('user');
    calls[1].resolve(withFacing('user').stream);
    await started;

    expect(session.phase).toBe('live');
    expect(session.facing).toBe('user');
    expect(localStorage.getItem(CAMERA_LENS_KEY)).toBe('environment');
    expect(console.warn).toHaveBeenCalled();
  });

  it('reads a webcam with no facing as the front lens even when the rear was remembered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(CAMERA_LENS_KEY, 'environment');
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    calls[0].resolve(withFacing(undefined).stream);
    await started;
    expect(session.facing).toBe('user');
  });

  it('does not hide a refusal behind the other lens: denied stays an error', async () => {
    localStorage.setItem(CAMERA_LENS_KEY, 'environment');
    const { open, calls } = deferredOpener();
    const session = new CameraSession(open);
    const started = session.start();
    calls[0].reject(new CameraAccessError('denied', 'no'));
    await started;
    expect(calls).toHaveLength(1);
    expect(session.phase).toBe('error');
    expect(session.fault).toBe('denied');
  });
});
