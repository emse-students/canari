// @vitest-environment happy-dom
/**
 * THE FULL-SCREEN CALL, AS A SCREEN-READER, A KEYBOARD AND THE SYSTEM BACK MEET IT.
 *
 * Each case fails without its fix (review of #2138): the ring is an ALERT with focus on Accept;
 * a state change is announced once, never the timer's every second; the chevron and Escape leave
 * the history stack through the binder (no entry accumulates over minimise/expand cycles); a voice
 * the engine refused says "tap to hear" and the next tap starts it.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { writable } from 'svelte/store';

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));
// The camera controls are drawn where video is on (a dev build): held on here.
vi.mock('$lib/features', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/features')>()),
  CALLS_VIDEO_ENABLED: true,
}));
// ...and the server's kill switch open to video (B12): `audio` hides the camera, tested below. It is
// REACTIVE like the real store (`set` re-renders what read it), so a flip mid-call can be tested.
const callsMode = vi.hoisted(() => {
  const state = {
    value: 'audio_video' as 'off' | 'audio' | 'audio_video',
    notify: () => {},
    set(mode: 'off' | 'audio' | 'audio_video') {
      state.value = mode;
      state.notify();
    },
  };
  return state;
});
vi.mock('$lib/stores/appVersionCheck.svelte', async () => {
  const { createSubscriber } = await import('svelte/reactivity');
  const subscribe = createSubscriber((update) => {
    callsMode.notify = update;
    return () => (callsMode.notify = () => {});
  });
  return {
    serverCallsMode: () => {
      subscribe();
      return callsMode.value;
    },
  };
});
const logs = vi.hoisted(() => [] as string[]);
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: (l: string) => logs.push(l) }));

import CallOverlay from './CallOverlay.svelte';
import type { CallService, CallState } from '$lib/services/CallService';
import { callView } from '$lib/stores/callView.svelte';
import { historyOverlayStackDepth, initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The screen fades out when it minimises: its cancelled animation needs an owner.
afterAll(adoptTransitionAnimations());

function fakeService(state: CallState) {
  return {
    callState: writable<CallState>(state),
    remoteStream: writable<MediaStream | null>(null),
    remoteStreams: writable(new Map<string, MediaStream>()),
    localStreamStore: writable<MediaStream | null>(null),
    isMuted: writable(false),
    isVideoOff: writable(true),
    cameraFacing: writable<'user' | 'environment'>('user'),
    canSwitchCamera: writable(false),
    incomingHasVideo: false,
    connectedAt: writable<number | null>(state === 'incall' ? 1 : null),
    endedAt: writable<number | null>(null),
    reconnecting: writable(false),
    e2eProven: writable(false),
    localMicSuspended: writable(false),
    peerMicSuspended: writable(false),
    videoSendReduced: writable(false),
    ringingOut: writable(false),
    currentGroupId: 'g',
    currentCallId: 'c',
    acceptCall: vi.fn(async () => {}),
    endCall: vi.fn(),
    toggleMute: vi.fn(),
    toggleVideo: vi.fn(),
    switchCamera: vi.fn(async () => {}),
  };
}

let stopHistory: () => void = () => {};
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  logs.length = 0;
  callView.reset();
  callView.setLocked(false);
  stopHistory = initHistoryOverlayStack();
  // jsdom has no media pipeline: a play() that resolves unless a test says otherwise.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  stopHistory();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function render(service: ReturnType<typeof fakeService>) {
  const c = mount(CallOverlay, {
    target: document.body,
    props: {
      callService: service as unknown as CallService,
      participants: [{ userId: 'bob', displayName: 'Bob' }],
    },
  });
  mounted.push(c);
  flushSync();
  await tick();
  return c;
}

const screen = () => document.querySelector<HTMLElement>('[data-testid="call-screen"]');

describe('the ring', () => {
  it('is an alertdialog with focus on Accept', async () => {
    await render(fakeService('incoming'));
    expect(screen()?.getAttribute('role')).toBe('alertdialog');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('call-accept');
  });

  it('is a plain dialog once answered', async () => {
    await render(fakeService('incall'));
    expect(screen()?.getAttribute('role')).toBe('dialog');
  });
});

describe('the screen every platform shows (call-screen parity)', () => {
  const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim();

  it('shows the peer name, a photo backdrop and a status on a ring, with decline BEFORE accept', async () => {
    await render(fakeService('incoming'));
    expect(screen()?.textContent).toContain('Bob');
    expect(text('call-status')).toBe(m.call_incoming_label());
    const backdrop = document.querySelector('[data-testid="call-backdrop"]');
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
    // Decline left, accept right: the order of Android's CallStyle ring and CallKit.
    const decline = document.querySelector('[data-testid="call-decline"]')!;
    const accept = document.querySelector('[data-testid="call-accept"]')!;
    expect(decline.compareDocumentPosition(accept) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(accept.className).toContain('bg-call-accept');
    expect(decline.className).toContain('bg-call-decline');
  });

  it('says "Calling..." on an outgoing call, with mute and hang-up and no accept', async () => {
    await render(fakeService('calling'));
    expect(text('call-status')).toBe(m.call_ringing_label());
    expect(document.querySelector('[data-testid="call-mute"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="call-hang-up"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="call-accept"]')).toBeNull();
  });

  it('shows the running time in a call, with the same backdrop', async () => {
    await render(fakeService('incall'));
    expect(text('call-status')).toMatch(/^\d+:\d{2}(:\d{2})?$/);
    expect(document.querySelector('[data-testid="call-backdrop"]')).not.toBeNull();
  });
});

describe('the live region', () => {
  it('announces the state, and "connected" rather than the running timer', async () => {
    const service = fakeService('incoming');
    await render(service);
    const announcer = () => document.querySelector('[data-testid="call-announcer"]');
    expect(announcer()?.getAttribute('role')).toBe('status');
    expect(announcer()?.textContent).toBe(m.call_incoming_label());

    service.callState.set('incall');
    service.connectedAt.set(1);
    flushSync();
    expect(announcer()?.textContent).toBe(m.call_live_announcement());

    service.reconnecting.set(true);
    flushSync();
    expect(announcer()?.textContent).toBe(m.call_reconnecting());
  });
});

describe('the encryption line', () => {
  // CALL-E2E-BYPASS-MI9T (2026-10-20): the screen said "end-to-end encrypted" on calls whose
  // frames never crossed the worker. The claim is drawn from evidence only.
  it('claims end-to-end encryption only once the service proved it', async () => {
    const service = fakeService('incall');
    await render(service);
    const line = () => document.querySelector('[data-testid="call-e2e-line"]')?.textContent?.trim();
    expect(line()).toBe(m.call_e2e_verifying());

    service.e2eProven.set(true);
    flushSync();
    expect(line()).toBe(m.call_e2e_encrypted_title());
  });
});

describe('the reduced-picture notice (quality ladder, 2026-10-21)', () => {
  const notice = () =>
    document.querySelector('[data-testid="call-video-reduced"]')?.textContent?.trim() ?? null;

  it('says this side sends a reduced picture only while its camera is on and the call live', async () => {
    const service = fakeService('incall');
    await render(service);
    service.videoSendReduced.set(true);
    flushSync();
    // Camera off: there is no picture to call reduced.
    expect(notice()).toBeNull();

    service.isVideoOff.set(false);
    flushSync();
    expect(notice()).toBe(m.call_video_reduced_notice());

    service.videoSendReduced.set(false);
    flushSync();
    expect(notice()).toBeNull();
  });
});

describe('a microphone a system took (WP-C-BG-I)', () => {
  // CALL-IOS-MIC-HIDDEN (2026-10-20): the partner heard nothing and nothing on its screen said why.
  const notice = () => document.querySelector('[data-testid="call-mic-notice"]');
  const announcer = () => document.querySelector('[data-testid="call-announcer"]');

  it('says the other party\'s phone took its microphone, then announces its return ONCE - never "connected" again', async () => {
    const service = fakeService('incall');
    await render(service);
    expect(notice()).toBeNull();
    expect(announcer()?.textContent).toBe(m.call_live_announcement());

    service.peerMicSuspended.set(true);
    flushSync();
    expect(notice()?.textContent?.trim()).toBe(m.call_mic_suspended_peer({ name: 'Bob' }));
    expect(announcer()?.textContent).toBe(m.call_mic_suspended_peer({ name: 'Bob' }));

    service.peerMicSuspended.set(false);
    flushSync();
    expect(notice()).toBeNull();
    expect(announcer()?.textContent).toBe(m.call_mic_restored_peer({ name: 'Bob' }));
  });

  it('says it is THIS phone, and leaves the return to the toast (no second announcement)', async () => {
    const service = fakeService('incall');
    await render(service);
    service.localMicSuspended.set(true);
    flushSync();
    expect(notice()?.textContent?.trim()).toBe(m.call_mic_suspended_local());
    expect(announcer()?.textContent).toBe(m.call_mic_suspended_local());

    service.localMicSuspended.set(false);
    flushSync();
    expect(notice()).toBeNull();
    expect(announcer()?.textContent).toBe('');
  });

  it('shows nothing while the call reconnects: that state is the more urgent one', async () => {
    const service = fakeService('incall');
    await render(service);
    service.peerMicSuspended.set(true);
    service.reconnecting.set(true);
    flushSync();
    expect(notice()).toBeNull();
    expect(announcer()?.textContent).toBe(m.call_reconnecting());

    // Back to live: announced as such, not as a recovery the region never reported.
    service.peerMicSuspended.set(false);
    service.reconnecting.set(false);
    flushSync();
    expect(announcer()?.textContent).toBe(m.call_live_announcement());
  });
});

describe('leaving the full screen', () => {
  it('minimises on Escape and on the chevron, and the history stack never grows over the cycles', async () => {
    await render(fakeService('incall'));
    expect(historyOverlayStackDepth()).toBe(1);
    const lengthOpen = history.length;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(callView.minimised).toBe(true);
    // The screen fades out (150 ms) before it leaves the DOM.
    await vi.waitFor(() => expect(screen()).toBeNull());
    expect(historyOverlayStackDepth()).toBe(0);

    callView.expand();
    flushSync();
    expect(historyOverlayStackDepth()).toBe(1);

    screen()!
      .querySelector<HTMLButtonElement>(`[aria-label="${m.call_minimize_label()}"]`)!
      .click();
    flushSync();
    expect(callView.minimised).toBe(true);
    expect(historyOverlayStackDepth()).toBe(0);

    callView.expand();
    flushSync();
    // The expand took the ghost the minimise left: no entry was added by the two cycles.
    expect(history.length).toBe(lengthOpen);
  });
});

describe('a voice the engine refused', () => {
  it('says "tap to hear", and the next tap anywhere starts it', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('no gesture', 'NotAllowedError'))
      .mockResolvedValue(undefined);
    const service = fakeService('incall');
    await render(service);

    service.remoteStream.set(new MediaStream());
    flushSync();
    await vi.waitFor(() => expect(callView.audioBlocked).toBe(true));
    flushSync();
    expect(document.querySelector('[data-testid="call-tap-to-hear"]')).not.toBeNull();

    window.dispatchEvent(new PointerEvent('pointerdown'));
    await vi.waitFor(() => expect(callView.audioBlocked).toBe(false));
    expect(play).toHaveBeenCalledTimes(2);
    flushSync();
    expect(document.querySelector('[data-testid="call-tap-to-hear"]')).toBeNull();
  });
});

describe('the PIN lock', () => {
  it('is never painted over: the full screen steps back while it is up', async () => {
    await render(fakeService('incoming'));
    expect(screen()).not.toBeNull();
    callView.setLocked(true);
    flushSync();
    await vi.waitFor(() => expect(screen()).toBeNull());
    callView.setLocked(false);
    flushSync();
    expect(screen()).not.toBeNull();
  });
});

describe('the size of every control', () => {
  // `iconButtonScale.test.ts` reads markup, and the big controls are drawn by a snippet it cannot
  // see through. So the RENDERED screen is held here: every button is either the shared icon button
  // or a 64px (`size-16`) call control - never a third size, in the ring or in the call.
  it.each(['incoming', 'incall'] as const)('is the icon button or 64px while %s', async (state) => {
    await render(fakeService(state));
    const buttons = [...screen()!.querySelectorAll('button')].filter(
      (b) => b.dataset.testid !== 'call-tap-to-hear'
    );
    expect(buttons.length).toBeGreaterThan(1);
    for (const b of buttons) {
      const ok = b.classList.contains('ui-icon-button') || b.classList.contains('size-16');
      expect(ok, b.getAttribute('aria-label') ?? b.outerHTML).toBe(true);
    }
  });
});

describe('a video call (lot 2)', () => {
  type FakeTrack = {
    kind: string;
    id: string;
    readyState: string;
    muted: boolean;
    addEventListener: () => void;
    removeEventListener: () => void;
  };
  let ids = 0;
  const track = (kind: string, muted = false): FakeTrack => ({
    kind,
    id: `${kind}-${++ids}`,
    readyState: 'live',
    muted,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  /** A stream as the call surfaces read it; the engine's own needs real tracks. */
  class FakeStream {
    constructor(public tracks: FakeTrack[] = []) {}
    getTracks() {
      return this.tracks;
    }
    getVideoTracks() {
      return this.tracks.filter((t) => t.kind === 'video');
    }
    getAudioTracks() {
      return this.tracks.filter((t) => t.kind === 'audio');
    }
  }
  beforeEach(() => {
    vi.stubGlobal('MediaStream', FakeStream);
    // happy-dom's element accepts only its own MediaStream; what is bound is not under test here.
    vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const selfView = () => document.querySelector<HTMLVideoElement>('[data-testid="call-self-view"]');
  const remoteView = () => document.querySelector('[data-testid="call-remote-video"]');
  const cameraOn = (service: ReturnType<typeof fakeService>) => {
    service.localStreamStore.set(
      new FakeStream([track('audio'), track('video')]) as unknown as MediaStream
    );
    service.isVideoOff.set(false);
    flushSync();
  };
  const peerVideo = (service: ReturnType<typeof fakeService>, muted = false) => {
    const stream = new FakeStream([track('audio'), track('video', muted)]);
    service.remoteStreams.set(new Map([['remote', stream as unknown as MediaStream]]));
    flushSync();
  };

  it('says a VIDEO call rings', async () => {
    const service = fakeService('incoming');
    service.incomingHasVideo = true;
    await render(service);
    expect(document.querySelector('[data-testid="call-status"]')?.textContent?.trim()).toBe(
      m.call_incoming_video_label()
    );
  });

  it('shows the self view full screen until the peer has a picture, then in a corner', async () => {
    const service = fakeService('incall');
    await render(service);
    expect(selfView()).toBeNull();
    cameraOn(service);
    expect(selfView()?.classList.contains('inset-0')).toBe(true);

    peerVideo(service);
    expect(remoteView()).not.toBeNull();
    expect(selfView()?.classList.contains('inset-0')).toBe(false);
    expect(selfView()?.classList.contains('w-28')).toBe(true);
  });

  it('mirrors the FRONT camera only', async () => {
    const service = fakeService('incall');
    await render(service);
    cameraOn(service);
    expect(selfView()?.classList.contains('-scale-x-100')).toBe(true);
    service.cameraFacing.set('environment');
    flushSync();
    expect(selfView()?.classList.contains('-scale-x-100')).toBe(false);
  });

  it("shows the avatar, not a frozen frame, while the peer's camera is off (its track muted)", async () => {
    const service = fakeService('incall');
    await render(service);
    peerVideo(service, true);
    expect(remoteView()).toBeNull();
    peerVideo(service, false);
    expect(remoteView()).not.toBeNull();
  });

  it('offers the camera switch only with the camera on and a second camera', async () => {
    const service = fakeService('incall');
    await render(service);
    const switchButton = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="call-switch-camera"]');
    cameraOn(service);
    expect(switchButton()).toBeNull();
    service.canSwitchCamera.set(true);
    flushSync();
    switchButton()!.click();
    expect(service.switchCamera).toHaveBeenCalledTimes(1);
    service.isVideoOff.set(true);
    flushSync();
    expect(switchButton()).toBeNull();
  });

  it('keeps four controls on one row at 390 px: the camera button sits beside the others', async () => {
    await render(fakeService('incall'));
    const camera = document.querySelector('[data-testid="call-camera"]');
    expect(camera).not.toBeNull();
    expect(camera!.closest('.gap-2')).not.toBeNull();
  });

  it('draws no camera control when the server allows audio only (calls_mode=audio)', async () => {
    callsMode.value = 'audio';
    try {
      await render(fakeService('incall'));
      expect(document.querySelector('[data-testid="call-camera"]')).toBeNull();
    } finally {
      callsMode.value = 'audio_video';
    }
  });

  // THE SWITCH GATES TURNING THE CAMERA ON, NEVER OFF. The mode moves mid-call when an admin closes
  // video; hiding the control then would leave a running camera with nothing on screen to stop it.
  it('keeps the camera control while the camera runs when the mode drops to audio mid-call', async () => {
    const service = fakeService('incall');
    const camera = () => document.querySelector<HTMLButtonElement>('[data-testid="call-camera"]');
    try {
      await render(service);
      cameraOn(service);
      expect(camera()).not.toBeNull();

      callsMode.set('audio');
      flushSync();
      expect(camera()).not.toBeNull();
      camera()!.click();
      expect(service.toggleVideo).toHaveBeenCalledTimes(1);

      service.isVideoOff.set(true);
      flushSync();
      expect(camera()).toBeNull();

      // The flip itself re-renders (the mock is as reactive as the store), so the pass above is real.
      callsMode.set('audio_video');
      flushSync();
      expect(camera()).not.toBeNull();
    } finally {
      callsMode.set('audio_video');
    }
  });
});
