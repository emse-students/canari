/**
 * The capture screen end to end, with the camera, the canvas and the recorder replaced: the shutter
 * waits for the server's cap and a decoded frame, ONE tap takes a photo, a press held past the
 * threshold films until it lifts, the result is reviewed, and a discard brings the preview back. The
 * threshold's timer is the only clock, advanced by the test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelCapture from './ReelCapture.svelte';
import { SHUTTER_HOLD_THRESHOLD_MS } from '$lib/reels/reelCapture';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import { installFakeMediaRecorder } from '$lib/reels/fakeMediaRecorder.test-helper';
import { ApiRefusalError } from '$lib/utils/apiRefusal';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The publish step fades in, and a test closes it mid-fade.
afterAll(adoptTransitionAnimations());

const getReelLimits = vi.fn();
vi.mock('$lib/posts/api', () => ({ getReelLimits: () => getReelLimits() }));
vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, goto: vi.fn() }));
vi.mock('$lib/utils/appVersion', () => ({
  isIosTauriRuntime: () => false,
  isMobileTauriRuntime: () => false,
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));
vi.mock('$lib/posts/postIdentity', async (orig) => ({
  ...(await orig<typeof import('$lib/posts/postIdentity')>()),
  listPostAsAssociations: () => Promise.resolve([]),
}));
vi.mock('$lib/components/shared/VideoPlayer.svelte', async () => ({
  default: (await import('./VideoPlayerStub.test-helper.svelte')).default,
}));

const framed = vi.hoisted(() => ({
  stop: vi.fn(),
  start: vi.fn(),
  photo: vi.fn(),
}));
vi.mock('$lib/reels/framedCapture', async (orig) => ({
  ...(await orig<typeof import('$lib/reels/framedCapture')>()),
  takeFramedPhoto: framed.photo,
  FramedStream: { start: framed.start },
}));

const mounted: Record<string, unknown>[] = [];
let Recorder: ReturnType<typeof installFakeMediaRecorder>;

function stream(): MediaStream {
  const track = { stop: vi.fn(), getCapabilities: () => ({}) };
  const s = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  Object.setPrototypeOf(s, MediaStream.prototype);
  return s as unknown as MediaStream;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  framed.photo.mockResolvedValue(new Blob(['jpg'], { type: 'image/jpeg' }));
  framed.start.mockReturnValue({ stream: stream(), bitrate: 3_000_000, stop: framed.stop });
  Recorder = installFakeMediaRecorder();
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:take', revokeObjectURL: () => {} })
  );
  getReelLimits.mockResolvedValue({
    maxDurationMs: 90_000,
    retentionDays: 30,
    warningWindowDays: 7,
  });
});

afterEach(() => {
  vi.useRealTimers();
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render() {
  const session = new CameraSession(() => Promise.resolve(stream()));
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(ReelCapture, { target, props: { session } }));
  await settle();
  // The shutter waits for a decoded frame, which jsdom never decodes: report one.
  const video = target.querySelector('video')!;
  Object.defineProperty(video, 'videoWidth', { value: 720, configurable: true });
  video.dispatchEvent(new Event('loadeddata'));
  await settle();
  const shutter = () => target.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
  const pointer = (type: string, timeStamp: number) => {
    const event = new PointerEvent(type, { pointerId: 1, bubbles: true });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    shutter().dispatchEvent(event);
  };
  /** A tap: down and up, the threshold never reached. */
  const tap = async () => {
    pointer('pointerdown', 1000);
    pointer('pointerup', 1100);
    await settle();
  };
  /** A hold: down, the threshold elapses with the finger still down, then the release. */
  const hold = async (release: 'pointerup' | 'pointercancel' = 'pointerup') => {
    pointer('pointerdown', 1000);
    vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
    await settle();
    pointer(release, 4000);
    await settle();
  };
  return { target, shutter, pointer, tap, hold };
}

describe('ReelCapture', () => {
  it('keeps the shutter disabled until the server has said how long a reel may be', async () => {
    let answer: (v: unknown) => void = () => {};
    getReelLimits.mockReturnValue(new Promise((r) => (answer = r)));
    const { shutter } = await render();
    expect(shutter().disabled).toBe(true);
    answer({ maxDurationMs: 90_000, retentionDays: 30, warningWindowDays: 7 });
    await settle();
    expect(shutter().disabled).toBe(false);
  });

  it('there is no separate photo button: the shutter is the only capture control', async () => {
    const { target } = await render();
    expect(target.querySelectorAll('[data-reel-shutter]')).toHaveLength(1);
    expect(target.textContent).not.toContain('Photo');
  });

  it('a TAP takes a photo and reviews it, and never starts a recorder', async () => {
    const { target, tap } = await render();
    await tap();
    expect(framed.photo).toHaveBeenCalledTimes(1);
    expect(framed.start).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  it('a HOLD films from the moment the threshold passes, and ends where it lifts', async () => {
    const { target, shutter, pointer } = await render();
    pointer('pointerdown', 1000);
    await settle();
    // Still down, under the threshold: nothing is recording yet.
    expect(shutter().getAttribute('aria-pressed')).toBe('false');
    vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
    await settle();
    expect(shutter().getAttribute('aria-pressed')).toBe('true');
    expect(framed.start).toHaveBeenCalledTimes(1);
    expect(framed.photo).not.toHaveBeenCalled();
    pointer('pointerup', 4000);
    await settle();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
    // The drawing stops with the take, after its last chunk.
    expect(framed.stop).toHaveBeenCalledTimes(1);
  });

  it('records at the bitrate the framed stream asks for', async () => {
    const { hold } = await render();
    await hold();
    expect(Recorder.instances[0].options.videoBitsPerSecond).toBe(3_000_000);
  });

  it('a cancelled touch after the threshold ends the take and keeps it', async () => {
    const { target, hold } = await render();
    await hold('pointercancel');
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  it('a cancelled touch before the threshold takes nothing', async () => {
    const { target, pointer } = await render();
    pointer('pointerdown', 1000);
    pointer('pointercancel', 1050);
    vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS * 2);
    await settle();
    expect(framed.photo).not.toHaveBeenCalled();
    expect(framed.start).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
  });

  it('a photo that cannot be made says so and returns to the preview', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    framed.photo.mockResolvedValue(null);
    const { target, tap } = await render();
    await tap();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });

  it('a discarded take brings the live preview back', async () => {
    const { target, hold } = await render();
    await hold();
    const discard = target.querySelector<HTMLButtonElement>(
      `[data-reel-review] button[aria-label="${m.reels_review_discard()}"]`
    )!;
    discard.click();
    await settle();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });

  it('says so, and offers a retry, when the cap cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getReelLimits.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { target, shutter } = await render();
    expect(shutter().disabled).toBe(true);
    expect(target.querySelector('[data-reel-limits-fault="unreachable"]')).not.toBeNull();
    const retry = target.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    retry.click();
    await settle();
    expect(getReelLimits).toHaveBeenCalledTimes(2);
    expect(shutter().disabled).toBe(false);
  });

  it('a server that answers with an error is not called unreachable, and may be retried', async () => {
    // What a server older than CanaReels answers: its `/:postId` route takes "reel-limits" (500).
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getReelLimits.mockRejectedValueOnce(new ApiRefusalError(500, null, 'post-service 500'));
    const { target, shutter } = await render();
    expect(shutter().disabled).toBe(true);
    const alert = target.querySelector('[data-reel-limits-fault="refused"]')!;
    expect(alert.textContent).toContain(m.reels_capture_limits_refused());
    expect(alert.textContent).not.toContain(m.reels_capture_limits_error());
    expect(alert.querySelector('button')).not.toBeNull();
  });

  it('Suivant opens the publish step over the take, and its back arrow returns to the take', async () => {
    const { target, hold } = await render();
    await hold();
    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    expect(target.querySelector('[data-reel-review]')).toBeNull();

    target.querySelector<HTMLButtonElement>('[data-reel-publish] header button')!.click();
    await settle();
    expect(target.querySelector('[data-reel-publish]')).toBeNull();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });
});
