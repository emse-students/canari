// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs: string[] = [];
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: (l: string) => logs.push(l) }));

import { bindCallVideo, isOwnRelease } from './callVideoElement';

/**
 * A call picture is shown only once it has a frame, and a `play()` its own release aborted is not a
 * failure (2026-11-07: a black square for a picture that never decoded, and "did not start:
 * AbortError" on every re-bind).
 */
class FakeStream {
  constructor(public tracks: unknown[]) {}
}

/** A `<video>` whose `play()` settles when the test says. */
function fakeVideo() {
  const el = document.createElement('video');
  document.body.append(el);
  let reject!: (e: unknown) => void;
  const played = new Promise<void>((_, r) => (reject = r));
  Object.defineProperty(el, 'srcObject', { value: null, writable: true });
  el.play = () => played;
  return { el, rejectPlay: reject };
}

const abort = () => new DOMException('The operation was aborted.', 'AbortError');
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  logs.length = 0;
  vi.stubGlobal('MediaStream', FakeStream);
});

describe('bindCallVideo', () => {
  it('says the first frame only at `loadeddata` - a live track whose frames never decode never reports one', () => {
    const { el } = fakeVideo();
    const onFrame = vi.fn();
    bindCallVideo(el, {} as MediaStreamTrack, 'remote video', onFrame);
    expect(onFrame).not.toHaveBeenCalled();
    el.dispatchEvent(new Event('loadeddata'));
    expect(onFrame).toHaveBeenCalledOnce();
  });

  it('says nothing for a frame that lands after the release', () => {
    const { el } = fakeVideo();
    const onFrame = vi.fn();
    const release = bindCallVideo(el, {} as MediaStreamTrack, 'remote video', onFrame);
    release();
    el.dispatchEvent(new Event('loadeddata'));
    expect(onFrame).not.toHaveBeenCalled();
    expect(el.srcObject).toBeNull();
  });

  it('logs nothing when its OWN release aborts the pending play()', async () => {
    const { el, rejectPlay } = fakeVideo();
    const release = bindCallVideo(el, {} as MediaStreamTrack, 'self view');
    release();
    rejectPlay(abort());
    await settle();
    expect(logs).toEqual([]);
  });

  it('logs an AbortError on a binding still in place - that one is not its own release', async () => {
    const { el, rejectPlay } = fakeVideo();
    bindCallVideo(el, {} as MediaStreamTrack, 'self view');
    rejectPlay(abort());
    await settle();
    expect(logs).toEqual([
      '[Call] self view did not start: AbortError: The operation was aborted.',
    ]);
  });

  it('logs every other refusal', async () => {
    const { el, rejectPlay } = fakeVideo();
    const release = bindCallVideo(el, {} as MediaStreamTrack, 'remote video');
    release();
    rejectPlay(new DOMException('no gesture', 'NotAllowedError'));
    await settle();
    expect(logs).toEqual(['[Call] remote video did not start: NotAllowedError: no gesture']);
  });
});

describe('isOwnRelease', () => {
  it('is an AbortError on a released binding or a detached element, and nothing else', () => {
    const attached = { isConnected: true };
    const detached = { isConnected: false };
    expect(isOwnRelease(abort(), true, attached)).toBe(true);
    expect(isOwnRelease(abort(), false, detached)).toBe(true);
    expect(isOwnRelease(abort(), false, attached)).toBe(false);
    expect(isOwnRelease(new DOMException('x', 'NotAllowedError'), true, detached)).toBe(false);
    expect(isOwnRelease(new Error('AbortError'), true, detached)).toBe(false);
  });
});
