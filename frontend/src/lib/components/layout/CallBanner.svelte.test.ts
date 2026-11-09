// @vitest-environment happy-dom
/**
 * THE MINIMISED CALL BAR KEEPS ITS CAMERA BUTTON IN BOTH STATES (owner, 2026-11-08).
 *
 * It used to render only while the camera ran, so after cutting it the camera could be restored
 * from the full screen alone. The button now toggles through the full screen's own handler
 * (`CallService.toggleVideo`), gated like the full screen: the server mode gates turning the camera
 * ON, never OFF.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { writable } from 'svelte/store';
import {
  initialNoiseSuppressionView,
  type NoiseSuppressionView,
} from '$lib/utils/callNoiseSuppression';

const mode = vi.hoisted(() => ({ value: 'audio_video' }));
const holder = vi.hoisted(() => ({ service: null as unknown }));

vi.mock('$lib/stores/appVersionCheck.svelte', () => ({ serverCallsMode: () => mode.value }));
vi.mock('$lib/features', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/features')>()),
  CALLS_VIDEO_ENABLED: true,
}));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: () => {} }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalConvs: { conversations: new Map() },
  globalSession: {
    userId: 'me',
    get callService() {
      return holder.service;
    },
  },
}));

import CallBanner from './CallBanner.svelte';
import { m } from '$lib/paraglide/messages';
import { callView } from '$lib/stores/callView.svelte';

function fakeService() {
  return {
    callState: writable('incall'),
    remoteStream: writable(null),
    remoteStreams: writable(new Map()),
    localStreamStore: writable(null),
    isMuted: writable(false),
    isVideoOff: writable(false),
    cameraFacing: writable('user'),
    canSwitchCamera: writable(false),
    connectedAt: writable<number | null>(1),
    endedAt: writable<number | null>(null),
    reconnecting: writable(false),
    e2eProven: writable(false),
    localMicSuspended: writable(false),
    peerMicSuspended: writable(false),
    videoSendReduced: writable(false),
    noiseSuppression: writable<NoiseSuppressionView>(initialNoiseSuppressionView()),
    ringingOut: writable(false),
    kind: 'direct',
    currentGroupId: 'g',
    incomingCallerId: null,
    acceptCall: vi.fn(async () => {}),
    endCall: vi.fn(),
    toggleMute: vi.fn(),
    toggleVideo: vi.fn(),
  };
}

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  holder.service = null;
  mode.value = 'audio_video';
  callView.reset();
  document.body.innerHTML = '';
});

async function render(service: ReturnType<typeof fakeService>) {
  holder.service = service;
  callView.reset();
  callView.minimise();
  mounted.push(mount(CallBanner, { target: document.body }));
  flushSync();
  await tick();
}
const button = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="call-banner-camera"]');

describe('the minimised bar camera button', () => {
  it('shows with the camera on, labelled to cut it, and cuts it through toggleVideo', async () => {
    const service = fakeService();
    await render(service);
    expect(button()?.getAttribute('aria-label')).toBe(m.call_disable_camera_label());
    button()!.click();
    expect(service.toggleVideo).toHaveBeenCalledTimes(1);
  });

  it('stays with the camera off, labelled to restore it, and restores it through the SAME toggleVideo', async () => {
    const service = fakeService();
    service.isVideoOff.set(true);
    await render(service);
    expect(button()?.getAttribute('aria-label')).toBe(m.call_enable_camera_label());
    button()!.click();
    expect(service.toggleVideo).toHaveBeenCalledTimes(1);
  });

  it('follows the camera across a cut: same button, label flips', async () => {
    const service = fakeService();
    await render(service);
    service.isVideoOff.set(true);
    flushSync();
    expect(button()?.getAttribute('aria-label')).toBe(m.call_enable_camera_label());
  });

  it('with video closed server side: gone while off, still there to cut a running camera', async () => {
    mode.value = 'audio';
    const service = fakeService();
    service.isVideoOff.set(true);
    await render(service);
    expect(button()).toBeNull();
    service.isVideoOff.set(false);
    flushSync();
    expect(button()).not.toBeNull();
  });
});
