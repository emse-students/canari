/**
 * The capture screen end to end, with the camera and the recorder replaced: the shutter waits for the
 * server's cap, a tap films until the next tap, a hold films until it lifts, the take is reviewed, and
 * a discard brings the preview back. Every step is driven by an event the test sends - no clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelCapture from './ReelCapture.svelte';
import { CameraSession } from '$lib/reels/cameraSession.svelte';
import { installFakeMediaRecorder } from '$lib/reels/fakeMediaRecorder.test-helper';
import { ApiRefusalError } from '$lib/utils/apiRefusal';
import { m } from '$lib/paraglide/messages';

const getReelLimits = vi.fn();
vi.mock('$lib/posts/api', () => ({ getReelLimits: () => getReelLimits() }));
vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, goto: vi.fn() }));
vi.mock('$lib/utils/appVersion', () => ({ isIosTauriRuntime: () => false }));
vi.mock('$lib/utils/historyOverlayStack', () => ({
  pushHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn(),
}));
vi.mock('$lib/components/shared/VideoPlayer.svelte', async () => ({
  default: (await import('./VideoPlayerStub.test-helper.svelte')).default,
}));

const mounted: Record<string, unknown>[] = [];

function stream(): MediaStream {
  const track = { stop: vi.fn(), getCapabilities: () => ({}) };
  const s = { getTracks: () => [track], getVideoTracks: () => [track] };
  Object.setPrototypeOf(s, MediaStream.prototype);
  return s as unknown as MediaStream;
}

beforeEach(() => {
  installFakeMediaRecorder();
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
  mounted.push(mount(ReelCapture, { target, props: { session, onNext: vi.fn() } }));
  await settle();
  const shutter = () => target.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
  const pointer = (type: string, timeStamp: number) => {
    const event = new PointerEvent(type, { pointerId: 1, bubbles: true });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    shutter().dispatchEvent(event);
  };
  return { target, shutter, pointer };
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

  it('a tap films until the next tap, then the take is reviewed', async () => {
    const { target, shutter, pointer } = await render();
    pointer('pointerdown', 1000);
    pointer('pointerup', 1100);
    await settle();
    expect(shutter().getAttribute('aria-pressed')).toBe('true');
    expect(target.querySelector('[data-reel-review]')).toBeNull();

    pointer('pointerdown', 9000);
    await settle();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  it('a hold films until it lifts', async () => {
    const { target, pointer } = await render();
    pointer('pointerdown', 1000);
    await settle();
    pointer('pointerup', 4000);
    await settle();
    expect(target.querySelector('[data-reel-review]')).not.toBeNull();
  });

  it('a discarded take brings the live preview back', async () => {
    const { target, pointer } = await render();
    pointer('pointerdown', 1000);
    pointer('pointerup', 4000);
    await settle();
    const discard = target.querySelector<HTMLButtonElement>('[data-reel-review] button')!;
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

  it('a server without reels (404) is not called unreachable, and offers no retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getReelLimits.mockRejectedValueOnce(new ApiRefusalError(404, null, 'post-service 404'));
    const { target, shutter } = await render();
    expect(shutter().disabled).toBe(true);
    const alert = target.querySelector('[data-reel-limits-fault="absent"]')!;
    expect(alert.textContent).toContain(m.reels_capture_limits_absent());
    expect(alert.querySelector('button')).toBeNull();
  });

  it('a server error is not called unreachable either, and may be retried', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getReelLimits.mockRejectedValueOnce(new ApiRefusalError(503, null, 'post-service 503'));
    const { target } = await render();
    const alert = target.querySelector('[data-reel-limits-fault="failed"]')!;
    expect(alert.textContent).toContain(m.reels_capture_limits_failed());
    expect(alert.querySelector('button')).not.toBeNull();
  });
});
