/**
 * THE STUDIO OF A DESKTOP LIVE (owner, 2026-11-14): the sources (camera, microphone, screen), the
 * current scene, the camera overlay and the two mutes - and the ONE stream the recorder records,
 * made once and never replaced: the compositor's canvas track (`liveCompositor.ts`) and the mixer's
 * sound track (`liveAudioMixer.svelte.ts`). Everything the member changes while on air changes what
 * is DRAWN or HEARD on those two tracks, never the tracks, so the recorder - and the viewers - see
 * one continuous stream through every scene switch.
 *
 * - The SCREEN is asked for only from a click (a browser opens its picker on nothing else), the
 *   first time a scene needs it; once granted it is KEPT for the live, and every later scene reuses
 *   it. A dismissed picker leaves the scene as it was.
 * - The share STOPPED from the browser's own bar (or its window closed) turns a scene that showed it
 *   into `pause` and says so: never into the camera, which would put the member's face where they had
 *   chosen to show something else, and never an end - the owner wants the live to go on.
 * - The CAMERA switched off draws its "camera off" card in its box; the MICROPHONE muted is its gain
 *   at 0. Neither stops a track the recorder records.
 *
 * Used only where {@link liveScenesAvailable} holds (a desktop browser); phones keep the camera
 * recorded directly (`liveBroadcast.svelte.ts`).
 */

import { m } from '$lib/paraglide/messages';
import { releaseCamera, CameraAccessError, type CameraFault } from '$lib/reels/cameraAccess';
import type { CameraOpener, CameraSession } from '$lib/reels/cameraSession.svelte';
import { LiveAudioMixer, type MixerContext } from './liveAudioMixer.svelte';
import { LiveCompositor, type CompositorDeps } from './liveCompositor';
import { workerFrameClock } from './liveFrameClock';
import { openLiveCamera, openLiveDisplay, openLiveMicrophone } from './liveDevice';
import {
  DEFAULT_OVERLAY,
  planSceneChange,
  sceneAfterScreenEnded,
  sceneShowsScreen,
  type LiveScene,
  type OverlaySettings,
} from './liveScenes';
import { LIVE_CAPTURE_FPS } from './constants';

/** Where the live's microphone stands. */
export type StudioMicPhase = 'stopped' | 'opening' | 'live' | 'error';

/** The compositor as the studio drives it (a fake in tests). */
export type StudioCompositor = Pick<
  LiveCompositor,
  'track' | 'start' | 'stop' | 'setScene' | 'setOverlay' | 'setCameraOn' | 'setLabels'
>;

/** The mixer as the studio drives it (a fake in tests). */
export type StudioMixer = Pick<
  LiveAudioMixer,
  | 'state'
  | 'track'
  | 'wake'
  | 'onStateChange'
  | 'setMic'
  | 'setShare'
  | 'setMicMuted'
  | 'setShareAudible'
  | 'close'
>;

/** Everything the studio reaches outside itself. */
export interface LiveStudioDeps {
  /** The camera's opener on a desktop live: the lens alone, the microphone being the studio's. */
  cameraOpener: CameraOpener;
  openMicrophone: () => Promise<MediaStream>;
  /** The screen picker; called from the click that chose a scene needing it. */
  openDisplay: () => Promise<MediaStream>;
  createMixer: () => StudioMixer;
  createCompositor: (
    overlay: OverlaySettings,
    sources: Pick<CompositorDeps, 'camera' | 'screen'>
  ) => StudioCompositor;
}

/** The real dependencies. */
export function defaultLiveStudioDeps(): LiveStudioDeps {
  return {
    cameraOpener: (facing, switching) => openLiveCamera(facing, switching, false),
    openMicrophone: openLiveMicrophone,
    openDisplay: openLiveDisplay,
    createMixer: () => new LiveAudioMixer(new AudioContext() as MixerContext),
    createCompositor: (overlay, sources) =>
      new LiveCompositor(overlay, {
        ...sources,
        createCanvas: () => document.createElement('canvas'),
        createVideo: () => document.createElement('video'),
        clock: workerFrameClock(LIVE_CAPTURE_FPS),
        now: () => performance.now(),
      }),
  };
}

export class LiveStudio {
  scene = $state<LiveScene>('camera');
  overlay = $state<OverlaySettings>({ ...DEFAULT_OVERLAY });
  micMuted = $state(false);
  /** False while the member switched the camera off. */
  cameraOn = $state(true);
  micPhase = $state<StudioMicPhase>('stopped');
  micFault = $state<CameraFault | null>(null);
  /** The shared screen, held from its grant to its end or the live's. */
  screen = $state.raw<MediaStream | null>(null);
  /** The picker is open: the scene bar waits for its answer. */
  choosingScreen = $state(false);
  /** The share ended from outside the app: the screen says so until the next scene chosen. */
  screenEnded = $state(false);

  /** What the recorder records: the composed picture and the mixed sound, for the studio's life. */
  readonly stream: MediaStream;
  /** What the member's preview shows: the SAME picture, without the sound (no echo). */
  readonly previewStream: MediaStream;

  readonly #deps: LiveStudioDeps;
  readonly #compositor: StudioCompositor;
  readonly #mixer: StudioMixer;
  #mic: MediaStream | null = null;
  #micWatch: AbortController | null = null;
  #screenWatch: AbortController | null = null;
  /** Bumped by every microphone open and by {@link release}: a stale open gives its stream back. */
  #micGeneration = 0;
  #released = false;

  constructor(
    readonly camera: CameraSession,
    deps: LiveStudioDeps = defaultLiveStudioDeps()
  ) {
    this.#deps = deps;
    // The camera opens its lens alone: the voice is the studio's own capture.
    camera.swapOpener(deps.cameraOpener);
    this.#mixer = deps.createMixer();
    this.#compositor = deps.createCompositor(this.overlay, {
      camera: () => (this.camera.phase === 'live' ? this.camera.stream : null),
      screen: () => this.screen,
    });
    this.#compositor.setLabels({
      pause: m.live_scene_pause_card(),
      cameraOff: m.live_scene_camera_off_card(),
    });
    this.stream = new MediaStream([this.#compositor.track, this.#mixer.track]);
    this.previewStream = new MediaStream([this.#compositor.track]);
    this.#applyScene();
    console.debug('[LIVE-STUDIO] studio made (scene camera)');
  }

  /** The microphone is open: a live has a voice, so Start waits for it. */
  get ready(): boolean {
    return this.micPhase === 'live';
  }

  /** Whether the mixed sound is flowing - the recorder writes NOTHING while it is not (`liveAudioMixer`). */
  get audioRunning(): boolean {
    return this.#mixer.state === 'running';
  }

  /** Opens the microphone and starts drawing; the camera is the session's to open. */
  async open(): Promise<void> {
    if (this.#released) {
      // A screen mounted after its live was given back: starting the clock now would leak a worker.
      console.warn('[LIVE-STUDIO] open() on a released studio - nothing started');
      return;
    }
    // The screen opens from the click on "En direct": the sound may run already, or wait for a click.
    this.wakeAudio();
    this.#compositor.start();
    await this.reopenMicrophone();
  }

  /** Opens (again) the microphone - the first time, or the Retry after it was refused or lost. */
  async reopenMicrophone(): Promise<void> {
    if (this.#released) return;
    const generation = ++this.#micGeneration;
    this.#dropMicrophone();
    this.micPhase = 'opening';
    this.micFault = null;
    try {
      const mic = await this.#deps.openMicrophone();
      if (generation !== this.#micGeneration) {
        console.debug('[LIVE-STUDIO] a microphone came back after the studio moved on - released');
        releaseCamera(mic);
        return;
      }
      this.#mic = mic;
      const track = mic.getAudioTracks()[0] ?? null;
      this.#mixer.setMic(track);
      const watch = new AbortController();
      this.#micWatch = watch;
      track?.addEventListener?.(
        'ended',
        () => {
          console.warn('[LIVE-STUDIO] the microphone ended (unplugged, or taken) - Retry offered');
          this.#dropMicrophone();
          this.micFault = 'interrupted';
          this.micPhase = 'error';
        },
        { signal: watch.signal }
      );
      this.micPhase = 'live';
      console.debug('[LIVE-STUDIO] microphone open');
    } catch (err) {
      if (generation !== this.#micGeneration) return;
      this.micFault = err instanceof CameraAccessError ? err.fault : 'unavailable';
      if (!(err instanceof CameraAccessError)) {
        console.error('[LIVE-STUDIO] the microphone opener threw something untyped', err);
      }
      this.micPhase = 'error';
      console.warn(`[LIVE-STUDIO] microphone not open (${this.micFault})`);
    }
  }

  /**
   * Who is told when the sound starts or stops running ({@link audioRunning} changed): the broadcast
   * pauses its recorder when it stops and starts a new one when it runs again.
   */
  onAudioChange(listener: (running: boolean) => void): void {
    this.#mixer.onStateChange((state) => listener(state === 'running'));
  }

  /** Asks the sound to run. Every click of the live screen calls it (see `liveAudioMixer`). */
  wakeAudio(): void {
    this.#mixer.wake();
  }

  /**
   * The member chose `next` in the scene bar - CALLED FROM THAT CLICK, because a scene that needs the
   * screen opens the picker, which a browser allows only inside one. Granted, the share is kept and
   * the scene switches; dismissed, nothing changes.
   */
  async selectScene(next: LiveScene): Promise<void> {
    // Synchronously, inside the click: the sound may still be waiting for one.
    this.wakeAudio();
    if (this.#released || this.choosingScreen) return;
    const plan = planSceneChange(this.scene, next, this.screen !== null);
    console.log(`[LIVE-STUDIO] scene ${this.scene} -> ${next}: ${plan.kind}`);
    if (plan.kind === 'stay') return;
    this.screenEnded = false;
    if (plan.kind === 'switch') {
      this.#setScene(plan.scene);
      return;
    }
    this.choosingScreen = true;
    try {
      const display = await this.#deps.openDisplay();
      if (this.#released) {
        console.debug('[LIVE-STUDIO] a screen came back after the studio closed - released');
        releaseCamera(display);
        return;
      }
      this.#takeScreen(display);
      this.#setScene(plan.scene);
    } catch (err) {
      const fault = err instanceof CameraAccessError ? err.fault : 'unavailable';
      console.warn(`[LIVE-STUDIO] no screen shared (${fault}) - the scene stays ${this.scene}`);
    } finally {
      this.choosingScreen = false;
    }
  }

  /** Moves, resizes or reshapes the camera overlay (a drag let go, a size or a shape chosen). */
  setOverlay(patch: Partial<OverlaySettings>): void {
    this.wakeAudio();
    const next = { ...this.overlay, ...patch };
    if (
      next.corner === this.overlay.corner &&
      next.size === this.overlay.size &&
      next.shape === this.overlay.shape
    ) {
      return;
    }
    console.debug(`[LIVE-STUDIO] overlay ${next.corner}, ${next.size}, ${next.shape}`);
    this.overlay = next;
    this.#compositor.setOverlay(next);
  }

  toggleMic(): void {
    this.wakeAudio();
    this.micMuted = !this.micMuted;
    console.log(`[LIVE-STUDIO] microphone ${this.micMuted ? 'muted' : 'on'}`);
    this.#mixer.setMicMuted(this.micMuted);
  }

  toggleCamera(): void {
    this.wakeAudio();
    this.cameraOn = !this.cameraOn;
    console.log(`[LIVE-STUDIO] camera ${this.cameraOn ? 'on' : 'off'}`);
    this.#compositor.setCameraOn(this.cameraOn);
  }

  /**
   * Gives back everything the studio holds - the microphone, the screen, the drawing and the sound -
   * at the end of a live or when the screen closes. Final: a studio is one live's.
   */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    ++this.#micGeneration;
    console.debug('[LIVE-STUDIO] releasing the studio');
    this.#dropMicrophone();
    this.#dropScreen();
    this.#compositor.stop();
    this.#mixer.close();
  }

  #setScene(scene: LiveScene): void {
    this.scene = scene;
    this.#applyScene();
  }

  /** The compositor draws the scene; the share's sound is heard only while the screen is shown. */
  #applyScene(): void {
    this.#compositor.setScene(this.scene);
    this.#mixer.setShareAudible(sceneShowsScreen(this.scene));
  }

  #takeScreen(display: MediaStream): void {
    this.#dropScreen();
    this.screen = display;
    this.#mixer.setShare(display.getAudioTracks()[0] ?? null);
    const watch = new AbortController();
    this.#screenWatch = watch;
    display.getVideoTracks()[0]?.addEventListener?.('ended', () => this.#screenGone(), {
      signal: watch.signal,
    });
    console.debug('[LIVE-STUDIO] screen held for the live');
  }

  /** The share ended from outside the app (the browser's bar, the shared window closed). */
  #screenGone(): void {
    const before = this.scene;
    this.#dropScreen();
    this.#setScene(sceneAfterScreenEnded(before));
    this.screenEnded = before !== this.scene;
    console.warn(
      `[LIVE-STUDIO] the screen share ended outside the app - scene ${before} -> ${this.scene}`
    );
  }

  #dropScreen(): void {
    this.#screenWatch?.abort();
    this.#screenWatch = null;
    if (this.screen) releaseCamera(this.screen);
    this.screen = null;
    this.#mixer.setShare(null);
  }

  #dropMicrophone(): void {
    this.#micWatch?.abort();
    this.#micWatch = null;
    if (this.#mic) releaseCamera(this.#mic);
    this.#mic = null;
    this.#mixer.setMic(null);
  }
}
