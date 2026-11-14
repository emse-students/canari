/**
 * Fakes for the desktop studio: a compositor that records what it is told, a mixer whose context
 * state a test sets, a microphone and a screen picker answering fake streams - and a `MediaStream`
 * class where the environment has none. The real `LiveStudio` runs on them.
 */
import { vi } from 'vitest';
import type { CameraSession } from '$lib/reels/cameraSession.svelte';
import { FakeTrack, fakeStream, type FakeStream } from './liveBroadcast.test-helper';
import { LiveStudio, type LiveStudioDeps } from './liveStudio.svelte';
import type { LiveScene, OverlaySettings } from './liveScenes';

/**
 * What the fake stream extends: the environment's own `MediaStream` where there is one (happy-dom
 * checks a `srcObject` against it), nothing in node.
 */
const StreamBase = (
  typeof MediaStream !== 'undefined' ? MediaStream : class {}
) as new () => object;

/** A `MediaStream` keeping the tracks it was given (node has none; happy-dom's drops them). */
export class FakeMediaStream extends StreamBase {
  constructor(private readonly tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => (t as unknown as { kind?: string }).kind !== 'audio');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => (t as unknown as { kind?: string }).kind === 'audio');
  }
}

/** A track with a kind, as the studio's streams are filtered by it. */
export function kindTrack(kind: 'video' | 'audio'): FakeTrack & { kind: string } {
  return Object.assign(new FakeTrack(), { kind });
}

export function fakeStudio() {
  const compositorTrack = kindTrack('video');
  const mixerTrack = kindTrack('audio');
  const compositor = {
    track: compositorTrack as unknown as MediaStreamTrack,
    scene: 'camera' as LiveScene,
    overlay: null as OverlaySettings | null,
    cameraOn: true,
    start: vi.fn(),
    stop: vi.fn(),
    setScene: vi.fn((s: LiveScene) => {
      compositor.scene = s;
    }),
    setOverlay: vi.fn((o: OverlaySettings) => {
      compositor.overlay = o;
    }),
    setCameraOn: vi.fn((on: boolean) => {
      compositor.cameraOn = on;
    }),
    setLabels: vi.fn(),
  };
  const mixer = {
    state: 'running' as AudioContextState,
    /** What a wake turns the state into: `running`, or the context staying suspended. */
    wakeTo: 'running' as AudioContextState,
    track: mixerTrack as unknown as MediaStreamTrack,
    mic: null as MediaStreamTrack | null,
    share: null as MediaStreamTrack | null,
    micMuted: false,
    shareAudible: false,
    wake: vi.fn(() => {
      mixer.state = mixer.wakeTo;
    }),
    /** The listener the studio registered: {@link becomes} fires it, as a `statechange` would. */
    listener: null as ((state: AudioContextState) => void) | null,
    onStateChange: vi.fn((l: (state: AudioContextState) => void) => {
      mixer.listener = l;
    }),
    /** The engine changes the context's state and fires its `statechange`. */
    becomes(state: AudioContextState) {
      mixer.state = state;
      mixer.listener?.(state);
    },
    setMic: vi.fn((t: MediaStreamTrack | null) => {
      mixer.mic = t;
    }),
    setShare: vi.fn((t: MediaStreamTrack | null) => {
      mixer.share = t;
    }),
    setMicMuted: vi.fn((v: boolean) => {
      mixer.micMuted = v;
    }),
    setShareAudible: vi.fn((v: boolean) => {
      mixer.shareAudible = v;
    }),
    close: vi.fn(),
  };
  const mics: FakeStream[] = [];
  const screens: FakeStream[] = [];
  const control = {
    /** The next microphone open's failure, once. */
    micFailure: null as unknown,
    /** The next picker's failure (a dismissal), once. */
    screenFailure: null as unknown,
  };
  const deps = {
    cameraOpener: vi.fn(async () => fakeStream().stream),
    openMicrophone: vi.fn(async () => {
      if (control.micFailure) {
        const e = control.micFailure;
        control.micFailure = null;
        throw e;
      }
      const s = fakeStream();
      mics.push(s);
      return s.stream;
    }),
    openDisplay: vi.fn(async () => {
      if (control.screenFailure) {
        const e = control.screenFailure;
        control.screenFailure = null;
        throw e;
      }
      const s = fakeStream();
      screens.push(s);
      return s.stream;
    }),
    createMixer: vi.fn(() => mixer),
    createCompositor: vi.fn((overlay: OverlaySettings) => {
      compositor.overlay = overlay;
      return compositor;
    }),
  } satisfies LiveStudioDeps;
  return { deps, compositor, mixer, mics, screens, control };
}

/** A real studio on fakes, over `camera`. `MediaStream` is stubbed by the caller where needed. */
export function studioOn(camera: CameraSession) {
  const f = fakeStudio();
  const studio = new LiveStudio(camera, f.deps);
  return { ...f, studio };
}
