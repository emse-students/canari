// @vitest-environment happy-dom
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
import { CameraAccessError } from '$lib/reels/cameraAccess';
import { installFakeMediaRecorder } from '$lib/reels/fakeMediaRecorder.test-helper';
import { ApiRefusalError } from '$lib/utils/apiRefusal';
import { pushHistoryOverlay } from '$lib/utils/historyOverlayStack';
import { capturePosterOf } from '$lib/reels/capturePoster';
import { isChatReelTake } from '$lib/reels/chatReelWriter';
import { m } from '$lib/paraglide/messages';
import type { PublishReelDeps } from '$lib/reels/publishReel';
import { toastStore } from '$lib/stores/toast.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { giveMediaStreamGetTracks } from '$lib/reels/mediaStreamTracks.test-helper';

giveMediaStreamGetTracks();

// The publish step fades in, and a test closes it mid-fade.
afterAll(adoptTransitionAnimations());

const showConfirm = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm }));
const getReelLimits = vi.fn();
vi.mock('$lib/posts/api', () => ({ getReelLimits: () => getReelLimits() }));
const goto = vi.hoisted(() => vi.fn());
/**
 * The router's hooks, as the screen registered them: a test plays a navigation that ends with the
 * screen mounted (`afterNavigate`) or one that does not happen (`beforeNavigate`'s `complete`).
 */
const router = vi.hoisted(() => ({
  after: [] as ((n: object) => void)[],
  before: [] as ((n: { complete: Promise<void> }) => void)[],
  /** `$app/state`'s `navigating.to`: a navigation under way. */
  navigating: { to: null as unknown },
}));
vi.mock('$app/navigation', () => ({
  afterNavigate: (cb: (n: object) => void) => router.after.push(cb),
  beforeNavigate: (cb: (n: { complete: Promise<void> }) => void) => router.before.push(cb),
  goto,
}));
vi.mock('$app/state', () => ({ navigating: router.navigating }));
const runtime = vi.hoisted(() => ({ iosApp: false }));
vi.mock('$lib/utils/appVersion', () => ({
  isIosTauriRuntime: () => runtime.iosApp,
  isAndroidTauriRuntime: () => false,
  isMobileTauriRuntime: () => runtime.iosApp,
}));
vi.mock('$lib/reels/videoDuration', () => ({ readVideoDurationMs: () => Promise.resolve(5_000) }));
const pickNatively = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/nativeAttachPicker', () => ({ pickNatively }));
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
  thumbnail: vi.fn(),
}));
vi.mock('$lib/reels/framedCapture', async (orig) => ({
  ...(await orig<typeof import('$lib/reels/framedCapture')>()),
  takeFramedPhoto: framed.photo,
  takeFramedThumbnail: framed.thumbnail,
  FramedStream: { start: framed.start },
}));

const mounted: Record<string, unknown>[] = [];
let Recorder: ReturnType<typeof installFakeMediaRecorder>;

/** A camera stream; `microphone: false` is a session whose microphone was refused. */
function stream(microphone = true): MediaStream {
  const track = { stop: vi.fn(), getCapabilities: () => ({}) };
  const audio = microphone ? [{ stop: vi.fn(), kind: 'audio' }] : [];
  const s = {
    getTracks: () => [track, ...audio],
    getVideoTracks: () => [track],
    getAudioTracks: () => audio,
  };
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
  showConfirm.mockReset();
  showConfirm.mockResolvedValue(true);
  vi.mocked(pushHistoryOverlay).mockClear();
  getReelLimits.mockResolvedValue({
    maxDurationMs: 90_000,
    retentionDays: 30,
    warningWindowDays: 7,
  });
});

afterEach(() => {
  runtime.iosApp = false;
  router.after.length = 0;
  router.before.length = 0;
  router.navigating.to = null;
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

async function render(extra: Record<string, unknown> = {}, microphone = true) {
  const session = new CameraSession(() => Promise.resolve(stream(microphone)));
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(ReelCapture, { target, props: { session, ...extra } }));
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

  it('the held finger zooms the take: UP zooms in, DOWN zooms out, and the next take starts at 1x (user, 2026-10-22)', async () => {
    const session = new CameraSession(() => Promise.resolve(stream()));
    const { target, shutter } = await render({ session });
    const finger = (type: string, clientY: number, timeStamp: number) => {
      const event = new PointerEvent(type, { pointerId: 1, bubbles: true, clientY });
      Object.defineProperty(event, 'timeStamp', { value: timeStamp });
      shutter().dispatchEvent(event);
    };
    finger('pointerdown', 700, 1000);
    // A slide BEFORE the press is a take decides nothing: a photo is still possible.
    finger('pointermove', 600, 1100);
    expect(session.zoom).toBe(1);
    vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
    await settle();

    finger('pointermove', 600, 1500); // the slide's base
    finger('pointermove', 450, 1600); // 150 px up: half the travel, sqrt(5)x
    expect(session.zoom).toBeCloseTo(Math.sqrt(5));
    finger('pointermove', 300, 1700);
    expect(session.zoom).toBeCloseTo(5);
    finger('pointermove', 450, 1800);
    expect(session.zoom).toBeCloseTo(Math.sqrt(5));
    flushSync();
    expect(target.querySelector('video')!.style.transform).toContain('scale(2.23');

    finger('pointerup', 450, 4000);
    await settle();
    // The review holds the camera off; discarding reopens it at 1x.
    expect(session.zoom).toBe(1);
  });

  it('a DOUBLE TAP during a held take flips the lens and the SAME recorder films on (user, 2026-10-22)', async () => {
    const mic = { kind: 'audio', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn() };
    const lens = (facing: string) => ({
      kind: 'video',
      readyState: 'live',
      facing,
      stop: vi.fn(),
      getCapabilities: () => ({}),
      addEventListener: vi.fn(),
    });
    const front = lens('user');
    const openLens = vi.fn(() =>
      Promise.resolve(new MediaStream([lens('environment')] as unknown as MediaStreamTrack[]))
    );
    const session = new CameraSession(
      () => Promise.resolve(new MediaStream([front, mic] as unknown as MediaStreamTrack[])),
      openLens
    );
    const { target, pointer } = await render({ session });
    pointer('pointerdown', 1000);
    vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
    await settle();
    expect(Recorder.instances).toHaveLength(1);

    // A second finger taps twice on the preview while the first holds the shutter.
    const preview = target.querySelector('video')!;
    for (const [type, t] of [
      ['pointerdown', 2000],
      ['pointerup', 2040],
      ['pointerdown', 2120],
      ['pointerup', 2160],
    ] as const) {
      const event = new PointerEvent(type, { pointerId: 2, bubbles: true, clientX: 9, clientY: 9 });
      Object.defineProperty(event, 'timeStamp', { value: t });
      preview.dispatchEvent(event);
    }
    await settle();

    expect(openLens).toHaveBeenCalledWith('environment');
    expect(session.facing).toBe('environment');
    expect(front.stop).toHaveBeenCalled();
    expect(mic.stop).not.toHaveBeenCalled();
    // Still the one take: no second recorder, no second framed stream, still recording.
    expect(Recorder.instances).toHaveLength(1);
    expect(framed.start).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[data-reel-shutter]')!.getAttribute('aria-pressed')).toBe('true');

    pointer('pointerup', 4000);
    await settle();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  describe('no flip while a press is decided or a take finishes (review of #2291)', () => {
    /** A session whose every open is counted, the microphone kept apart to see it released. */
    function countedSession() {
      const mic = { kind: 'audio', readyState: 'live', stop: vi.fn(), addEventListener: vi.fn() };
      const lens = () => ({
        kind: 'video',
        readyState: 'live',
        stop: vi.fn(),
        getCapabilities: () => ({}),
        addEventListener: vi.fn(),
      });
      const open = vi.fn(() =>
        Promise.resolve(new MediaStream([lens(), mic] as unknown as MediaStreamTrack[]))
      );
      const openLens = vi.fn(() =>
        Promise.resolve(new MediaStream([lens()] as unknown as MediaStreamTrack[]))
      );
      return { mic, open, openLens, session: new CameraSession(open, openLens) };
    }

    /** A second finger's double tap on the preview. */
    function doubleTapPreview(target: HTMLElement) {
      const preview = target.querySelector('video')!;
      for (const [type, t] of [
        ['pointerdown', 2000],
        ['pointerup', 2040],
        ['pointerdown', 2120],
        ['pointerup', 2160],
      ] as const) {
        const event = new PointerEvent(type, {
          pointerId: 2,
          bubbles: true,
          clientX: 9,
          clientY: 9,
        });
        Object.defineProperty(event, 'timeStamp', { value: t });
        preview.dispatchEvent(event);
      }
    }

    const flipButton = (target: HTMLElement) =>
      target.querySelector<HTMLButtonElement>(`[aria-label="${m.reels_camera_switch()}"]`)!;

    it('PRESSING: the double tap and the button stand down, and the hold films on the lens it pressed on', async () => {
      const { mic, open, openLens, session } = countedSession();
      const { target, pointer } = await render({ session });
      expect(flipButton(target).disabled).toBe(false);
      pointer('pointerdown', 1000);
      await settle();

      expect(flipButton(target).disabled).toBe(true);
      doubleTapPreview(target);
      flipButton(target).click();
      await settle();
      expect(open).toHaveBeenCalledTimes(1);
      expect(openLens).not.toHaveBeenCalled();
      expect(mic.stop).not.toHaveBeenCalled();

      vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
      await settle();
      expect(Recorder.instances).toHaveLength(1);
      expect(session.facing).toBe('user');
      // Recording again: the flip is offered back.
      expect(flipButton(target).disabled).toBe(false);
    });

    it('FINISHING: neither the double tap nor the button releases the microphone under the last chunk', async () => {
      const { mic, open, openLens, session } = countedSession();
      const { target, pointer } = await render({ session });
      pointer('pointerdown', 1000);
      vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
      await settle();
      // The recorder's last chunk does not arrive: the take stays in `finishing`.
      const recorder = Recorder.instances[0];
      recorder.stop = vi.fn(() => {
        recorder.state = 'inactive';
      });
      pointer('pointerup', 4000);
      await settle();
      expect(recorder.stop).toHaveBeenCalled();
      expect(target.querySelector('[data-reel-review]')).toBeNull();

      expect(flipButton(target).disabled).toBe(true);
      doubleTapPreview(target);
      flipButton(target).click();
      await settle();
      expect(open).toHaveBeenCalledTimes(1);
      expect(openLens).not.toHaveBeenCalled();
      expect(mic.stop).not.toHaveBeenCalled();
      expect(session.facing).toBe('user');
    });
  });

  it('a lens lost DURING a take ends the take and keeps it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const openLens = vi.fn(() => Promise.reject(new CameraAccessError('busy', 'busy')));
    const session = new CameraSession(() => Promise.resolve(stream()), openLens);
    const { target, pointer } = await render({ session });
    pointer('pointerdown', 1000);
    vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
    await settle();
    await session.flipDuringTake();
    await settle();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
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

  const discardButton = (target: HTMLElement) =>
    target.querySelector<HTMLButtonElement>(
      `[data-reel-review] button[aria-label="${m.reels_review_discard()}"]`
    )!;
  /** The Back handler of the take's history entry: what Android's Back / the iOS swipe call. */
  const backHandler = () => {
    const calls = vi.mocked(pushHistoryOverlay).mock.calls;
    return calls[calls.length - 1][0];
  };

  it('a discarded take brings the live preview back, once the member confirmed', async () => {
    const { target, hold } = await render();
    await hold();
    discardButton(target).click();
    await settle();
    expect(showConfirm).toHaveBeenCalledOnce();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });

  it('keeps the take when the member does not confirm the discard', async () => {
    showConfirm.mockResolvedValueOnce(false);
    const { target, hold } = await render();
    await hold();
    discardButton(target).click();
    await settle();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  it('Back on a review asks first, and keeping the take re-arms Back', async () => {
    const { target, hold } = await render();
    await hold();
    const pushes = vi.mocked(pushHistoryOverlay).mock.calls.length;
    showConfirm.mockResolvedValueOnce(false);
    backHandler()();
    await settle();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
    expect(vi.mocked(pushHistoryOverlay).mock.calls.length).toBe(pushes + 1);

    backHandler()();
    await settle();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });

  /** The root layout's `beforeNavigate` drain: the entry's handler runs with the reason. */
  const navigationDrain = () => backHandler()('navigation');

  it('LEAVING the screen with a review (a published reel lands on the feed) asks nothing', async () => {
    const { target, hold } = await render();
    await hold();
    navigationDrain();
    await settle();
    expect(showConfirm).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
  });

  it('LEAVING the screen with the publish step open asks nothing', async () => {
    const { target, hold } = await render();
    await hold();
    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    navigationDrain();
    await settle();
    expect(showConfirm).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-publish]')).toBeNull();
  });

  it('LEAVING the screen with the editor open asks nothing, and leaves no entry behind', async () => {
    const { target, hold } = await render();
    await hold();
    target
      .querySelector<HTMLButtonElement>(
        `[data-reel-review] [aria-label="${m.reels_review_edit()}"]`
      )!
      .click();
    await settle();
    const pushes = vi.mocked(pushHistoryOverlay).mock.calls.length;
    navigationDrain();
    await settle();
    expect(showConfirm).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-editor]')).toBeNull();
    expect(vi.mocked(pushHistoryOverlay).mock.calls.length).toBe(pushes);
  });

  it('LEAVING the screen while recording drops the take, asks nothing, and gives the camera back', async () => {
    const { target, pointer } = await render();
    pointer('pointerdown', 1000);
    vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
    await settle();
    navigationDrain();
    await settle();
    expect(showConfirm).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
    // The screen is going: the camera is closed with it, never left open behind the next page.
    expect(target.querySelector('[data-camera-phase="stopped"]')).not.toBeNull();
    expect(framed.stop).toHaveBeenCalled();
  });

  it('no Back swipe arms while the editor owns the strokes or a take is being filmed (review of #1936)', async () => {
    const { target, pointer } = await render();
    const root = () => target.querySelector('[data-swipe-back-off]');
    expect(root()).toBeNull();
    // Filming: a swipe would have thrown the take away unasked.
    pointer('pointerdown', 1000);
    vi.advanceTimersByTime(SHUTTER_HOLD_THRESHOLD_MS);
    await settle();
    expect(root()).not.toBeNull();
    pointer('pointerup', 4000);
    await settle();
    // The review: the swipe is a Back again (it asks).
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
    expect(root()).toBeNull();
    // The editor: a paint stroke from the left edge dragged the whole layer, then left the editor.
    target
      .querySelector<HTMLButtonElement>(
        `[data-reel-review] [aria-label="${m.reels_review_edit()}"]`
      )!
      .click();
    await settle();
    expect(root()).not.toBeNull();
    expect(root()!.contains(target.querySelector('[data-reel-surface]'))).toBe(true);
  });

  it('Back with the editor open leaves the editor, never the take', async () => {
    const { target, hold } = await render();
    await hold();
    target
      .querySelector<HTMLButtonElement>(
        `[data-reel-review] [aria-label="${m.reels_review_edit()}"]`
      )!
      .click();
    await settle();
    backHandler()();
    await settle();
    // No edits: the editor closes without asking, and the review (not the camera) is back.
    expect(showConfirm).not.toHaveBeenCalled();
    expect(target.querySelector('[data-reel-editor]')).toBeNull();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
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

  it("the editor's Next goes straight to the publish step, with no stop at the review", async () => {
    const { target, hold } = await render();
    await hold();
    target
      .querySelector<HTMLButtonElement>(
        `[data-reel-review] [aria-label="${m.reels_review_edit()}"]`
      )!
      .click();
    await settle();
    expect(target.querySelector('[data-reel-editor]')).not.toBeNull();
    target.querySelector<HTMLButtonElement>('[data-reel-editor-next]')!.click();
    await settle();
    expect(target.querySelector('[data-reel-editor]')).toBeNull();
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    expect(target.querySelector('[data-reel-review]')).toBeNull();
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

describe('the default camera opener follows the destination (how the microphone is asked)', () => {
  it.each([
    // [destination, the requests' audio: false = none, true = asked]
    ['chat', [false]],
    ['post', [false, true]],
    ['feed', [true]],
  ] as const)('%s asks %j', async (destination, requests) => {
    vi.stubGlobal('screen', { width: 393, height: 851 });
    const lens = stream();
    const getUserMedia = vi.fn().mockResolvedValue(lens);
    vi.stubGlobal('navigator', { userAgent: '', mediaDevices: { getUserMedia } });
    // The post camera joins its two answers into one stream.
    const Real = MediaStream;
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(tracks: { kind?: string }[]) {
          const joined = {
            getTracks: () => tracks,
            getVideoTracks: () => tracks.filter((t) => t.kind !== 'audio'),
            getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
          };
          // The element's `srcObject` accepts only a MediaStream.
          Object.setPrototypeOf(joined, Real.prototype);
          return joined;
        }
      }
    );
    const target = document.createElement('div');
    document.body.appendChild(target);
    // No injected session: the component builds its own, which is what ships.
    mounted.push(mount(ReelCapture, { target, props: { destination, oncapture: vi.fn() } }));
    await settle();

    expect(
      getUserMedia.mock.calls.map(([c]) => c.audio !== false && c.audio !== undefined)
    ).toEqual(requests);
  });
});

describe('ReelCapture as a composer destination (D-camera, 2026-10-11)', () => {
  it('a chat photo is handed back as an ordinary image FILE and the camera closes', async () => {
    const oncapture = vi.fn();
    const onclose = vi.fn();
    const { target, tap } = await render({ destination: 'chat', oncapture, onclose });

    await tap();
    const next = target.querySelector<HTMLButtonElement>('[data-reel-next]')!;
    expect(next.textContent?.trim()).toBe(m.reels_review_add());
    next.click();
    await settle();

    expect(oncapture).toHaveBeenCalledTimes(1);
    const file = oncapture.mock.calls[0][0] as File;
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toMatch(/^canari-photo-\d+\.jpg$/);
    expect(onclose).toHaveBeenCalledTimes(1);
    // No publish step, no identity picker: a chat message has neither.
    expect(target.querySelector('[data-reel-publish]')).toBeNull();
  });

  it('a chat never films: a hold is still a photo, and it reads no reel limit', async () => {
    const { target, hold } = await render({ destination: 'chat', oncapture: vi.fn() });

    await hold();

    expect(getReelLimits).not.toHaveBeenCalled();
    expect(Recorder.instances).toHaveLength(0);
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
    expect(target.querySelector('[data-reel-media]')?.tagName).toBe('IMG');
  });

  it('a post take is offered as "Add" and has no sound button or gallery shortcut', async () => {
    const oncapture = vi.fn();
    const { target, tap } = await render({ destination: 'post', oncapture, onclose: vi.fn() });
    expect(target.querySelector('[aria-label="' + m.reels_capture_gallery() + '"]')).toBeNull();

    await tap();

    expect(target.querySelector('[data-reel-next]')?.textContent?.trim()).toBe(
      m.reels_review_add()
    );
    expect(target.querySelector('[data-reel-sound]')).toBeNull();
  });

  it('a video filmed in the post EDITOR carries its first picture as its thumbnail, taken BEFORE the recorder starts (Mi 9T, v1.2.9-alpha.1)', async () => {
    const still = new Blob(['first-frame'], { type: 'image/jpeg' });
    framed.thumbnail.mockReturnValue(still);
    const oncapture = vi.fn();
    const { target, hold } = await render({
      destination: 'post-edit',
      oncapture,
      onclose: vi.fn(),
    });
    await hold();
    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();

    const file = oncapture.mock.calls[0][0] as File;
    expect(file.type).toMatch(/^video\//);
    expect(capturePosterOf(file)).toBe(still);
    // Its encode shares the main thread with nothing the take draws: no drawing loop yet.
    expect(framed.thumbnail.mock.invocationCallOrder[0]).toBeLessThan(
      framed.start.mock.invocationCallOrder[0]
    );
    // A full-size photo is never encoded for it.
    expect(framed.photo).not.toHaveBeenCalled();
  });

  it('a film in a chat that may film is offered as "Send" - the gesture that queues it at once (RC-5)', async () => {
    const oncapture = vi.fn();
    const { target, hold } = await render({
      destination: 'chat',
      chatFilms: true,
      oncapture,
      onclose: vi.fn(),
    });
    await hold();
    const next = target.querySelector<HTMLButtonElement>('[data-reel-next]')!;
    expect(next.textContent?.trim()).toBe(m.reel_chat_send());
    next.click();
    await settle();

    const file = oncapture.mock.calls[0][0] as File;
    expect(file.type).toMatch(/^video\//);
    expect(isChatReelTake(file)).toBe(true);
  });

  it('a post camera whose microphone was refused still takes photos: a hold is a photo, and it is said', async () => {
    const { target, hold } = await render({ destination: 'post', oncapture: vi.fn() }, false);
    expect(toastStore.toasts.map((t) => t.message)).toContain(m.reels_capture_no_microphone());

    await hold();

    expect(Recorder.instances).toHaveLength(0);
    expect(target.querySelector('[data-reel-media]')?.tagName).toBe('IMG');
  });

  it('a post photo needs no reel cap: the shutter works while the cap is unread (offline)', async () => {
    getReelLimits.mockReturnValue(new Promise(() => {}));
    const { target, shutter, tap } = await render({ destination: 'post', oncapture: vi.fn() });
    expect(shutter().disabled).toBe(false);

    await tap();

    expect(target.querySelector('[data-reel-media]')?.tagName).toBe('IMG');
  });

  it('a discard question answered "keep" after the camera closed pushes no dead history entry', async () => {
    let answer: (keep: boolean) => void = () => {};
    showConfirm.mockReturnValue(new Promise<boolean>((r) => (answer = (keep) => r(!keep))));
    const { tap } = await render({ destination: 'chat', oncapture: vi.fn(), onclose: vi.fn() });
    await tap();
    expect(vi.mocked(pushHistoryOverlay)).toHaveBeenCalledTimes(1);
    const takeClose = vi.mocked(pushHistoryOverlay).mock.calls[0][0];

    // Back #1 asks; Back #2 closes the camera (its owner unmounts it) while the question is up.
    takeClose('back');
    await settle();
    unmount(mounted.pop()!);
    answer(true);
    await settle();

    expect(vi.mocked(pushHistoryOverlay)).toHaveBeenCalledTimes(1);
  });

  it('in the iOS app the gallery is the native library, never an input WebKit would answer with its camera', async () => {
    runtime.iosApp = true;
    const clip = new File([new Uint8Array(3)], 'clip.mp4', { type: 'video/mp4' });
    pickNatively.mockResolvedValue([clip]);
    const { target } = await render();
    expect(target.querySelector('input[type="file"]')).toBeNull();

    target
      .querySelector<HTMLButtonElement>('[aria-label="' + m.reels_capture_gallery() + '"]')!
      .click();
    await settle();
    await settle();

    expect(pickNatively).toHaveBeenCalledWith('library', { single: true });
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  it('a video picked while the picker took the camera away still reaches the review', async () => {
    // Android: the picker backgrounds the app, the camera is released and CameraScreen drops its
    // controls. The file then comes back to the input - which must still be in the document, or
    // Svelte's root-delegated `onchange` never runs (Mi 9T, v1.2.9-alpha.4, 3 of 3).
    const { target } = await render();
    const input = target.querySelector<HTMLInputElement>('[data-reel-gallery-input]')!;
    expect(input).not.toBeNull();
    const shown = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(target.querySelector('[data-reel-shutter]')).toBeNull();
    expect(input.isConnected).toBe(true);

    const clip = new File([new Uint8Array(3)], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(input, 'files', { value: [clip], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await settle();
    shown.mockRestore();

    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  it('a refused camera keeps the gallery, and its pick reaches the review', async () => {
    const session = new CameraSession(() =>
      Promise.reject(new CameraAccessError('denied', 'camera: denied'))
    );
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(ReelCapture, { target, props: { session } }));
    await settle();
    expect(target.querySelector('[role="alert"]')).not.toBeNull();
    const button = target.querySelector<HTMLButtonElement>('[data-reel-fault-gallery]')!;
    expect(button.disabled).toBe(false);
    const input = target.querySelector<HTMLInputElement>('[data-reel-gallery-input]')!;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    button.click();
    expect(click).toHaveBeenCalledTimes(1);

    const clip = new File([new Uint8Array(3)], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(input, 'files', { value: [clip], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await settle();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  it('a pick the state cannot take is said, never dropped in silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { target } = await render();
    const input = target.querySelector<HTMLInputElement>('[data-reel-gallery-input]')!;
    const pick = async (name: string) => {
      const clip = new File([new Uint8Array(3)], name, { type: 'video/mp4' });
      Object.defineProperty(input, 'files', { value: [clip], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await settle();
    };
    await pick('first.mp4');
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
    // A second answer while the first is under review (a picker that answered twice).
    await pick('second.mp4');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was refused in review'));
    expect(toastStore.toasts.map((t) => t.message)).toContain(m.reels_capture_take_refused());
  });

  it('a pick that cannot be taken is said, never dropped', async () => {
    const { target } = await render();
    const input = target.querySelector<HTMLInputElement>('[data-reel-gallery-input]')!;
    const doc = new File([new Uint8Array(3)], 'notes.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [doc], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(toastStore.toasts.map((t) => t.message)).toContain(m.reels_capture_not_a_video());
  });

  it('the feed keeps its gallery shortcut and the publish step', async () => {
    const { target } = await render();
    expect(target.querySelector('[aria-label="' + m.reels_capture_gallery() + '"]')).not.toBeNull();
  });
});

describe('one camera, one behaviour (user, 2026-10-19): a video filmed from the new-post composer is a CanaReel', () => {
  function publishDeps(): PublishReelDeps {
    return {
      assertNotMuted: vi.fn(async () => {}),
      getToken: vi.fn(async () => 'tok'),
      uploadLimits: vi.fn(async () => ({ maxPlaintextBytes: 1000 })),
      prepare: vi.fn(async () => ({
        file: new File([new Uint8Array(4)], 'reel.mp4', { type: 'video/mp4' }),
        width: 720,
        height: 1280,
        durationSeconds: 3,
        sourceBytes: 8,
        outputBytes: 4,
      })),
      upload: vi.fn(async () => ({
        type: 'video' as const,
        mediaId: 'm-1',
        key: 'k',
        iv: 'i',
        mimeType: 'video/mp4',
        size: 4,
      })),
      createPost: vi.fn(async () => ({ id: 'p-1' }) as never),
    };
  }

  /** Films one take, presses the review's Next, then the publish step's "Publier". */
  async function filmAndPublish(extra: Record<string, unknown>) {
    const deps = publishDeps();
    const { target, hold } = await render({ publishDeps: deps, ...extra });
    await hold();
    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    const sheet = target.querySelector('[data-reel-publish]');
    target.querySelector<HTMLButtonElement>('[data-reel-publish-submit]')?.click();
    await settle();
    return { deps, sheet, target };
  }

  it.each(['feed', 'post'] as const)(
    'a Back during the upload cannot lead to a SECOND publish of the same take (%s)',
    async (destination) => {
      const deps = publishDeps();
      deps.upload = vi.fn(() => new Promise<never>(() => {}));
      const { target, hold } = await render({
        publishDeps: deps,
        destination,
        oncapture: vi.fn(),
        onclose: vi.fn(),
      });
      await hold();
      target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
      await settle();
      target.querySelector<HTMLButtonElement>('[data-reel-publish-submit]')!.click();
      await settle();

      // Back, as the system or the edge swipe sends it to the top entry: the sheet's.
      vi.mocked(pushHistoryOverlay).mock.calls.at(-1)![0]('back');
      await settle();

      // Still the publish step, its "Publier" disabled: no review to press "Suivant" on again.
      expect(target.querySelector('[data-reel-review]')).toBeNull();
      expect(target.querySelector<HTMLButtonElement>('[data-reel-publish-submit]')!.disabled).toBe(
        true
      );
      expect(deps.upload).toHaveBeenCalledTimes(1);
    }
  );

  it('the same filmed video creates the same post from the tab and from the composer: kind reel, its duration', async () => {
    const tab = await filmAndPublish({});
    unmount(mounted.pop()!);
    const oncapture = vi.fn();
    const onpublished = vi.fn();
    const onclose = vi.fn();
    const composer = await filmAndPublish({
      destination: 'post',
      oncapture,
      onpublished,
      onclose,
      composerCaption: 'hello',
      composerIdentity: '',
    });

    expect(tab.sheet).not.toBeNull();
    expect(composer.sheet).not.toBeNull();
    const created = (d: PublishReelDeps) => vi.mocked(d.createPost).mock.calls[0][0];
    expect(created(tab.deps)).toMatchObject({ kind: 'reel', durationMs: 3000 });
    expect(created(composer.deps)).toMatchObject({
      kind: 'reel',
      durationMs: 3000,
      markdown: 'hello',
    });
    // The tab lands on the feed; the composer closes behind its reel, never handed a file.
    expect(goto).toHaveBeenCalledTimes(1);
    expect(onpublished).toHaveBeenCalledWith('');
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(oncapture).not.toHaveBeenCalled();
  });

  it('from the composer the publish step says the reel is deleted, and "Garder comme post" hands the video back', async () => {
    const still = new Blob(['first-frame'], { type: 'image/jpeg' });
    framed.thumbnail.mockReturnValue(still);
    const oncapture = vi.fn();
    const onclose = vi.fn();
    const { target, hold } = await render({
      destination: 'post',
      oncapture,
      onclose,
      publishDeps: publishDeps(),
    });
    await hold();
    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    expect(target.querySelector('[data-reel-publish-composer-notice]')).not.toBeNull();

    target.querySelector<HTMLButtonElement>('[data-reel-keep-as-post]')!.click();
    await settle();

    const file = oncapture.mock.calls[0][0] as File;
    expect(file.type).toMatch(/^video\//);
    expect(capturePosterOf(file)).toBe(still);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('"Garder comme post" applies the step\'s caption and identity only to a take the composer received', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onkept = vi.fn();
    const received: string[] = [];
    const oncapture = vi.fn(() => received.push('take'));
    onkept.mockImplementation(() => received.push('caption'));
    const { target, hold } = await render({
      destination: 'post',
      oncapture,
      onkept,
      onclose: vi.fn(),
      publishDeps: publishDeps(),
    });
    await hold();
    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    target.querySelector<HTMLButtonElement>('[data-reel-keep-as-post]')!.click();
    await settle();
    expect(received).toEqual(['take', 'caption']);
    unmount(mounted.pop()!);

    // No `oncapture`: the take is lost (and said so), and the composer's text is NOT touched.
    const lost = vi.fn();
    const second = await render({ destination: 'post', onkept: lost, publishDeps: publishDeps() });
    await second.hold();
    second.target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    second.target.querySelector<HTMLButtonElement>('[data-reel-keep-as-post]')!.click();
    await settle();
    expect(lost).not.toHaveBeenCalled();
  });

  it('a PHOTO from the new-post composer is still handed back as a file', async () => {
    const oncapture = vi.fn();
    const { target, tap } = await render({ destination: 'post', oncapture, onclose: vi.fn() });
    await tap();
    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    expect((oncapture.mock.calls[0][0] as File).type).toBe('image/jpeg');
    expect(target.querySelector('[data-reel-publish]')).toBeNull();
  });

  it('the post EDITOR attaches a filmed video and never opens the reel publish step', async () => {
    const oncapture = vi.fn();
    const { target, hold } = await render({
      destination: 'post-edit',
      oncapture,
      onclose: vi.fn(),
    });
    await hold();
    expect(target.querySelector('[data-reel-next]')?.textContent?.trim()).toBe(
      m.reels_review_add()
    );
    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    expect((oncapture.mock.calls[0][0] as File).type).toMatch(/^video\//);
    expect(target.querySelector('[data-reel-publish]')).toBeNull();
  });
});

describe('the camera does not open again once the member has left it (Mi 9T, 2026-10-28)', () => {
  /** A session whose every open is counted: a start is an open, whatever comes of it. */
  async function renderCounted(extra: Record<string, unknown> = {}) {
    const open = vi.fn(() => Promise.resolve(stream()));
    const view = await render({ session: new CameraSession(open), ...extra });
    return { ...view, open };
  }
  const lastEntry = () => {
    const calls = vi.mocked(pushHistoryOverlay).mock.calls;
    return calls[calls.length - 1][0];
  };
  /** The page hides then shows again, as a backgrounding app does. */
  const setVisibility = async (state: 'hidden' | 'visible') => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
  };
  afterEach(() => vi.restoreAllMocks());

  it('a take dropped because the screen is being LEFT (a published reel lands on the feed) opens no camera', async () => {
    const { target, hold, open } = await renderCounted();
    await hold();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
    const opens = open.mock.calls.length;

    lastEntry()('navigation');
    await settle();

    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(open.mock.calls.length).toBe(opens);
    expect(target.querySelector('[data-camera-phase="stopped"]')).not.toBeNull();
  });

  /** Every `afterNavigate` registered: a link navigation that ended with this screen mounted. */
  const navigationEndedHere = async () => {
    for (const cb of router.after) cb({ from: null, to: null, shallow: false, type: 'link' });
    await settle();
  };
  /** A navigation begins (`beforeNavigate`) and drains the take, as the root layout does. */
  const navigationDrainsTake = async () => {
    let refuse: (e: unknown) => void = () => {};
    const complete = new Promise<void>((_, reject) => (refuse = reject));
    for (const cb of router.before) cb({ complete });
    lastEntry()('navigation');
    await settle();
    return { refuse };
  };

  it('a navigation that ends with the screen still MOUNTED opens the camera again', async () => {
    const { target, hold, open } = await renderCounted();
    await hold();
    const opens = open.mock.calls.length;
    await navigationDrainsTake();
    expect(open.mock.calls.length).toBe(opens);

    await navigationEndedHere();

    expect(open.mock.calls.length).toBe(opens + 1);
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });

  it('a navigation that drained the take and was then CANCELLED opens the camera again', async () => {
    const { target, hold, open } = await renderCounted();
    await hold();
    const opens = open.mock.calls.length;
    const { refuse } = await navigationDrainsTake();
    expect(open.mock.calls.length).toBe(opens);

    refuse(new Error('cancelled'));
    await settle();

    expect(open.mock.calls.length).toBe(opens + 1);
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });

  it('a navigation refused because a NEWER one is under way leaves the camera closed', async () => {
    const { target, hold, open } = await renderCounted();
    await hold();
    const opens = open.mock.calls.length;
    const { refuse } = await navigationDrainsTake();

    router.navigating.to = { url: new URL('https://canari.test/feed') };
    refuse(new Error('aborted'));
    await settle();

    expect(open.mock.calls.length).toBe(opens);
    expect(target.querySelector('[data-camera-phase="stopped"]')).not.toBeNull();
  });

  it('the page restored from the back-forward cache opens the camera again; a fresh show does not', async () => {
    const { target, hold, open } = await renderCounted();
    await hold();
    const opens = open.mock.calls.length;
    await navigationDrainsTake();

    // The test DOM's event does not carry `persisted`: it is given as a browser would set it.
    const pageShow = (persisted: boolean) => {
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: persisted });
      window.dispatchEvent(event);
    };
    pageShow(false);
    await settle();
    expect(open.mock.calls.length).toBe(opens);

    pageShow(true);
    await settle();
    expect(open.mock.calls.length).toBe(opens + 1);
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });

  it('a take handed to a composer opens no camera behind it', async () => {
    const { target, tap, open } = await renderCounted({
      destination: 'chat',
      oncapture: vi.fn(),
      onclose: vi.fn(),
    });
    await tap();
    const opens = open.mock.calls.length;

    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();

    expect(open.mock.calls.length).toBe(opens);
    expect(target.querySelector('[data-camera-phase="stopped"]')).not.toBeNull();
  });

  it('a take in REVIEW, its editor or its publish step: the app coming back opens no camera', async () => {
    const { target, hold, open } = await renderCounted();
    await hold();
    const opens = open.mock.calls.length;
    await setVisibility('hidden');
    await setVisibility('visible');
    target.querySelector<HTMLButtonElement>('[data-reel-next]')!.click();
    await settle();
    expect(target.querySelector('[data-reel-publish]')).not.toBeNull();
    await setVisibility('hidden');
    await setVisibility('visible');

    expect(open.mock.calls.length).toBe(opens);
  });

  it('the gallery picker returning into a REVIEW opens no camera on the way', async () => {
    const { target, open } = await renderCounted();
    const input = target.querySelector<HTMLInputElement>('[data-reel-gallery-input]')!;
    vi.spyOn(input, 'click').mockImplementation(() => {});
    target
      .querySelector<HTMLButtonElement>('[aria-label="' + m.reels_capture_gallery() + '"]')!
      .click();
    const opens = open.mock.calls.length;
    // Android: the picker backgrounds the app; it comes back, then the file lands.
    await setVisibility('hidden');
    await setVisibility('visible');
    expect(open.mock.calls.length).toBe(opens);

    const clip = new File([new Uint8Array(3)], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(input, 'files', { value: [clip], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await settle();

    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
    expect(open.mock.calls.length).toBe(opens);
  });

  it('a gallery picker closed with nothing picked brings the preview back', async () => {
    const { target, open } = await renderCounted();
    const input = target.querySelector<HTMLInputElement>('[data-reel-gallery-input]')!;
    vi.spyOn(input, 'click').mockImplementation(() => {});
    target
      .querySelector<HTMLButtonElement>('[aria-label="' + m.reels_capture_gallery() + '"]')!
      .click();
    const opens = open.mock.calls.length;
    await setVisibility('hidden');
    await setVisibility('visible');
    expect(open.mock.calls.length).toBe(opens);

    input.dispatchEvent(new Event('cancel'));
    await settle();

    expect(open.mock.calls.length).toBe(opens + 1);
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });

  it('a gallery picker that NEVER says it closed leaves a tap that brings the camera back', async () => {
    // An engine with no `cancel` event on a file input (Chromium < 113, Safari < 16.4), or a native
    // dismissal the plugin never settles: no answer ever comes.
    const { target, open } = await renderCounted();
    const input = target.querySelector<HTMLInputElement>('[data-reel-gallery-input]')!;
    vi.spyOn(input, 'click').mockImplementation(() => {});
    target
      .querySelector<HTMLButtonElement>('[aria-label="' + m.reels_capture_gallery() + '"]')!
      .click();
    const opens = open.mock.calls.length;
    await setVisibility('hidden');
    expect(target.querySelector('[data-camera-reopen]')).toBeNull();
    await setVisibility('visible');
    expect(open.mock.calls.length).toBe(opens);

    const reopen = target.querySelector<HTMLButtonElement>('[data-camera-reopen]')!;
    expect(reopen.textContent?.trim()).toBe(m.reels_camera_reopen());
    reopen.click();
    await settle();

    expect(open.mock.calls.length).toBe(opens + 1);
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
    expect(target.querySelector('[data-camera-reopen]')).toBeNull();
  });

  it('a picked file the camera cannot take brings the preview back', async () => {
    const { target, open } = await renderCounted();
    const input = target.querySelector<HTMLInputElement>('[data-reel-gallery-input]')!;
    vi.spyOn(input, 'click').mockImplementation(() => {});
    target
      .querySelector<HTMLButtonElement>('[aria-label="' + m.reels_capture_gallery() + '"]')!
      .click();
    const opens = open.mock.calls.length;
    await setVisibility('hidden');
    await setVisibility('visible');

    const doc = new File([new Uint8Array(3)], 'notes.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [doc], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(target.querySelector('[data-reel-review]')).toBeNull();
    expect(open.mock.calls.length).toBe(opens + 1);
    expect(target.querySelector('[data-camera-phase="live"]')).not.toBeNull();
  });
});
