/**
 * The camera session gives back what an acquisition RETURNS, even when the acquisition finishes after
 * the member has moved on (left the tab, switched lens, backgrounded the app). Pinned by ordering,
 * never by a clock: each test resolves the opener's promises in the order it wants.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraSession } from './cameraSession.svelte';
import { CameraAccessError, type CameraFacing } from './cameraAccess';

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
  } as unknown as MediaStream;
  return { stream, stop, video };
}

/** An opener whose calls resolve only when the test says so. */
function deferredOpener() {
  const calls: {
    facing: CameraFacing;
    resolve: (s: MediaStream) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const open = (facing: CameraFacing) =>
    new Promise<MediaStream>((resolve, reject) => calls.push({ facing, resolve, reject }));
  return { open, calls };
}

afterEach(() => vi.restoreAllMocks());

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
});
