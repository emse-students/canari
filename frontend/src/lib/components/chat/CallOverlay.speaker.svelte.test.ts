// @vitest-environment happy-dom
/**
 * WHERE THE VOICE GOES, AS THE ANDROID SERVICE IS TOLD (review of #2723).
 *
 * The owner's first production audio call started on the loudspeaker. The overlay decides the
 * default from the call (audio -> earpiece, video -> loudspeaker), moves it to the loudspeaker when
 * video shows mid-call, and tells the service whether `speaker` is that default or the user's tap -
 * a default yields to a connected headset natively, a tap does not.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { writable } from 'svelte/store';
import {
  initialNoiseSuppressionView,
  type NoiseSuppressionView,
} from '$lib/utils/callNoiseSuppression';

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));
vi.mock('$lib/features', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/features')>()),
  CALLS_VIDEO_ENABLED: true,
}));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({ serverCallsMode: () => 'audio_video' }));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: () => {} }));
// The Android app: the overlay opens the ongoing-call service session.
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isAndroidTauriRuntime: () => true,
  isIosTauriRuntime: () => false,
}));

import CallOverlay from './CallOverlay.svelte';
import { m } from '$lib/paraglide/messages';
import type { CallService, CallState } from '$lib/services/CallService';
import { callView } from '$lib/stores/callView.svelte';
import { initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';

type FakeTrack = {
  kind: string;
  id: string;
  readyState: string;
  muted: boolean;
  addEventListener: () => void;
  removeEventListener: () => void;
};
let ids = 0;
const track = (kind: string): FakeTrack => ({
  kind,
  id: `${kind}-${++ids}`,
  readyState: 'live',
  muted: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});
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

function fakeService(state: CallState, hasVideo: boolean) {
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
    hasVideo,
    connectedAt: writable<number | null>(1),
    endedAt: writable<number | null>(null),
    reconnecting: writable(false),
    e2eProven: writable(false),
    localMicSuspended: writable(false),
    peerMicSuspended: writable(false),
    videoSendReduced: writable(false),
    noiseSuppression: writable<NoiseSuppressionView>(initialNoiseSuppressionView()),
    toggleNoiseSuppression: vi.fn(),
    currentGroupId: 'g',
    currentCallId: 'c',
    acceptCall: vi.fn(async () => {}),
    endCall: vi.fn(),
    toggleMute: vi.fn(),
    toggleVideo: vi.fn(),
    switchCamera: vi.fn(async () => {}),
  };
}

/** Every description the overlay sent the service, in order. */
const sent: { speaker: boolean; speakerChosen: boolean; callId: string }[] = [];
let stopHistory: () => void = () => {};
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  sent.length = 0;
  callView.reset();
  callView.setLocked(false);
  stopHistory = initHistoryOverlayStack();
  vi.stubGlobal('MediaStream', FakeStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
  const record = (json: string) => sent.push(JSON.parse(json));
  (window as unknown as { canariCall: unknown }).canariCall = {
    start: record,
    update: record,
    stop: () => {},
    pageLoaded: () => {},
  };
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  stopHistory();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { canariCall?: unknown }).canariCall;
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

const micHeld = (service: ReturnType<typeof fakeService>, video = false) => {
  service.localStreamStore.set(
    new FakeStream(
      video ? [track('audio'), track('video')] : [track('audio')]
    ) as unknown as MediaStream
  );
  flushSync();
};
const last = () => sent[sent.length - 1];

describe('the voice the Android service is told to route', () => {
  it('an AUDIO call: the earpiece, as a default', async () => {
    const service = fakeService('incall', false);
    await render(service);
    micHeld(service);
    expect(last()).toMatchObject({ speaker: false, speakerChosen: false });
  });

  it('a VIDEO call: the loudspeaker, as a default a headset may take over', async () => {
    const service = fakeService('incall', true);
    await render(service);
    micHeld(service, true);
    expect(last()).toMatchObject({ speaker: true, speakerChosen: false });
  });

  it('an audio call whose camera turns on moves to the loudspeaker, still as a default', async () => {
    const service = fakeService('incall', false);
    await render(service);
    micHeld(service);
    expect(last()).toMatchObject({ speaker: false });

    micHeld(service, true);
    service.isVideoOff.set(false);
    flushSync();
    expect(last()).toMatchObject({ speaker: true, speakerChosen: false });

    // The camera off again: the voice stays where it went.
    service.isVideoOff.set(true);
    flushSync();
    expect(last()).toMatchObject({ speaker: true, speakerChosen: false });
  });
});

describe('the speaker toggle shows the route the service APPLIED', () => {
  beforeEach(() => {
    // The toggle is drawn only where the engine could route at all.
    vi.stubGlobal('AudioContext', class {});
    if (!('mediaDevices' in navigator)) {
      Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    }
  });

  const routed = (speaker: boolean | null) => {
    const detail: Record<string, unknown> = { kind: 'output', callId: last().callId };
    if (speaker !== null) detail.speaker = speaker;
    window.dispatchEvent(new CustomEvent('canari:call-native', { detail }));
    flushSync();
  };
  const toggle = () => document.querySelector<HTMLButtonElement>('[data-testid="call-speaker"]')!;

  it('a loudspeaker default that yielded to a headset reads the earpiece, and the first tap is the loudspeaker', async () => {
    const service = fakeService('incall', true);
    await render(service);
    micHeld(service, true);
    expect(last()).toMatchObject({ speaker: true, speakerChosen: false });
    // Before the service says anything, the toggle shows what the page asked.
    expect(toggle().getAttribute('aria-label')).toBe(m.call_speaker_label());

    routed(false); // a headset took the voice
    expect(toggle().getAttribute('aria-label')).toBe(m.call_earpiece_label());

    // The first tap is audible: it asks the loudspeaker, as the user's own choice.
    toggle().click();
    flushSync();
    expect(last()).toMatchObject({ speaker: true, speakerChosen: true });
  });

  it('an unknown route (the platform routes) falls back to what the page asked', async () => {
    const service = fakeService('incall', true);
    await render(service);
    micHeld(service, true);
    routed(false);
    routed(null);
    expect(toggle().getAttribute('aria-label')).toBe(m.call_speaker_label());
  });
});
