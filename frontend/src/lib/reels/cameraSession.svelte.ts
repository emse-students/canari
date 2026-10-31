/**
 * The camera tab's live preview: which lens is open, whether it opened, and the torch (CanaReels, C5).
 *
 * WHY A SESSION AND NOT A `getUserMedia` IN `onMount`. The device is acquired ASYNCHRONOUSLY - a
 * permission prompt the first time, a hardware start every time - and three things can overtake it:
 * the member leaving the tab, switching lens, or the app going to the background. Each of them must
 * give back what the acquisition RETURNS, which does not exist yet when they happen. So every open
 * carries a generation number, and an open that comes back to a session that has moved on releases
 * its own stream instead of installing it. That is a fact recorded when the request was made, never
 * a delay hoping the request has finished (durable-rules: a cleanup that releases something acquired
 * asynchronously must wait for the acquisition).
 *
 * THE START IS HONEST ABOUT THE SLIDE. The tab swipe mounts its destination only after the finger
 * lifts (design-reference section 38), so the preview cannot be under the finger: the page appears
 * on `starting`, which draws a dark frame and says the camera is opening, and turns `live` when the
 * first track is in hand.
 */

import {
  CameraAccessError,
  countVideoInputs,
  openPhotoCamera,
  openReelCamera,
  releaseCamera,
  setTorch,
  torchSupported,
  type CameraFacing,
  type CameraFault,
} from './cameraAccess';
import {
  DIGITAL_ZOOM_RANGE,
  clampZoom,
  restingZoom,
  zoomRangeFor,
  type ZoomMode,
  type ZoomRange,
} from './cameraZoom';

/** Where the preview stands. */
export type CameraPhase = 'starting' | 'live' | 'error' | 'stopped';

/** The opener, injectable so the session's ordering can be tested without a camera. */
export type CameraOpener = (facing: CameraFacing, switching?: boolean) => Promise<MediaStream>;

export class CameraSession {
  phase = $state<CameraPhase>('stopped');
  fault = $state<CameraFault | null>(null);
  /**
   * THE CAMERA OPENS ON THE FRONT LENS (user, 2026-10-02: the selfie is a reel's usual first shot).
   * Not persisted: every session of the tab starts here, and the flip button is per take.
   */
  facing = $state<CameraFacing>('user');
  stream = $state.raw<MediaStream | null>(null);
  torchOn = $state(false);
  /** Read from the open track, never assumed: the front lenses measured have no torch. */
  torchAvailable = $state(false);

  /** The open stream carries a LIVE microphone: false with none, or once its track ended. */
  microphone = $state(false);

  /**
   * A lens flip DURING A TAKE is in flight ({@link flipDuringTake}): the old lens is stopped and the
   * new one not yet in hand. The phase stays `live` - the shutter under the member's finger must not
   * unmount - and the take holds its last frame meanwhile.
   */
  flipping = $state(false);

  /** How the open lens zooms, read from its track (`cameraZoom.ts`). */
  zoomRange = $state.raw<ZoomRange>(DIGITAL_ZOOM_RANGE);
  /** The zoom level now: 1x on every new lens, moved only by {@link setZoom}. */
  zoom = $state(1);
  /** The zoom modes already logged this session: the mode is said once, never per gesture. */
  readonly #zoomModesLogged: Partial<Record<ZoomMode, true>> = {};
  /** The hardware level asked for and not yet applied; one `applyConstraints` is in flight at most. */
  #zoomWanted: number | null = null;
  #zoomApplying = false;
  /** The open lens refused its own `zoom` capability once: its zoom stays where it is (logged). */
  #zoomRefused = false;

  /** Removes the `ended` listeners of the tracks in hand; replaced at each open, run at each release. */
  #trackListeners: AbortController | null = null;

  /** Bumped by every open and every stop; an acquisition that returns to another number is stale. */
  #generation = 0;
  /**
   * The app left the screen while an open was in flight ({@link suspend}): the open's answer is still
   * awaited, and a stream it brings back is given back at once, since nothing is on screen to use it.
   */
  #suspended = false;
  readonly #open: CameraOpener;
  /** Opens a LENS ALONE, no microphone: a flip during a take keeps the take's microphone. */
  readonly #openLens: CameraOpener;

  /**
   * How many cameras the device has, read once a camera is OPEN and again on `devicechange`; 0 until
   * known. The switch button is offered only from two (owner, 2026-10-31): one lens has nothing to
   * switch to.
   */
  cameraCount = $state(0);
  /** Whether there is another lens to switch to. */
  canSwitch = $derived(this.cameraCount >= 2);
  /** Aborts the `devicechange` listener; set while the session watches the device list. */
  #deviceWatch: AbortController | null = null;
  readonly #countCameras: () => Promise<number>;

  constructor(
    open: CameraOpener = openReelCamera,
    openLens: CameraOpener = openPhotoCamera,
    countCameras: () => Promise<number> = countVideoInputs
  ) {
    this.#open = open;
    this.#openLens = openLens;
    this.#countCameras = countCameras;
  }

  /** Reads the camera count now; a list that cannot be read is logged and offers no switch. */
  async #refreshCameraCount(): Promise<void> {
    try {
      const count = await this.#countCameras();
      if (count !== this.cameraCount) console.debug(`[camera-session] ${count} camera(s)`);
      this.cameraCount = count;
    } catch (err) {
      console.warn('[camera-session] the camera list could not be read - no switch offered', err);
      this.cameraCount = 0;
    }
  }

  /** Counts the cameras now and on every `devicechange` until {@link stop}; one listener at most. */
  #watchCameras(): void {
    void this.#refreshCameraCount();
    if (this.#deviceWatch || typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    const watch = new AbortController();
    this.#deviceWatch = watch;
    navigator.mediaDevices.addEventListener('devicechange', () => void this.#refreshCameraCount(), {
      signal: watch.signal,
    });
  }

  /** Opens `facing` (the current lens by default), releasing whatever was open first. */
  async start(facing: CameraFacing = this.facing, switching = false): Promise<void> {
    const generation = ++this.#generation;
    console.debug(`[camera-session] start ${facing} (#${generation})`);
    this.#releaseCurrent();
    this.#suspended = false;
    this.facing = facing;
    this.phase = 'starting';
    this.fault = null;
    try {
      const stream = await this.#open(facing, switching);
      if (generation !== this.#generation) {
        console.debug(
          `[camera-session] #${generation} came back after the session moved on - releasing it`
        );
        releaseCamera(stream);
        return;
      }
      if (this.#suspended) {
        // Granted while the app was away (a backgrounding that was not the permission dialog): the
        // camera is not held in the background; the return opens it again (`resume`).
        console.debug(`[camera-session] #${generation} granted while the app is away - released`);
        this.#suspended = false;
        releaseCamera(stream);
        this.phase = 'stopped';
        return;
      }
      this.stream = stream;
      this.#install(stream, generation);
      this.phase = 'live';
      this.#watchCameras();
    } catch (err) {
      if (generation !== this.#generation) return;
      const away = this.#suspended;
      this.#suspended = false;
      const fault = err instanceof CameraAccessError ? err.fault : 'unavailable';
      if (!(err instanceof CameraAccessError)) {
        console.error('[camera-session] the opener threw something untyped', err);
      }
      // A REFUSAL is the member's answer, whether or not the app was away while it was given (the
      // permission dialog backgrounds it): shown once, never asked again behind their back. Any OTHER
      // failure while away is the background's (Android will not start a camera for a hidden app),
      // not the member's: the session is stopped, and the return opens it again (`resume`).
      if (away && fault !== 'denied') {
        console.warn(
          `[camera-session] #${generation} failed while the app was away (${fault}) - reopened on return`
        );
        this.phase = 'stopped';
        return;
      }
      this.fault = fault;
      this.phase = 'error';
    }
  }

  /** The other lens, outside a take: everything is reopened ({@link start}). A take uses {@link flipDuringTake}. */
  switchFacing(): Promise<void> {
    const next = otherFacing(this.facing);
    console.debug(`[camera-session] switch to ${next}`);
    return this.start(next, true);
  }

  /**
   * The other lens DURING A TAKE (user, 2026-10-22: a double tap flips the lens while filming).
   *
   * ONLY THE LENS IS REPLACED. The microphone tracks in hand are KEPT - never stopped, never asked
   * again - so the recorder, which records them and a canvas track (`FramedStream`), sees no change
   * in its track set and its sound runs on uninterrupted. The old lens is stopped BEFORE the new one
   * is asked for: a phone opens one camera at a time. The new stream is the new lens plus the kept
   * microphone. The phase stays `live` throughout ({@link flipping} says the lens is missing), so the
   * shutter held under the member's finger is never unmounted.
   *
   * A NEW LENS THAT CANNOT BE OPENED ENDS THE SESSION as any refused open does (`error`, its fault):
   * the take has lost its picture and its owner ends it (`ReelCapture`). The old lens is not reopened
   * behind the member's back.
   */
  async flipDuringTake(): Promise<void> {
    const current = this.stream;
    if (this.phase !== 'live' || !current || this.flipping) {
      console.warn(
        `[camera-session] a flip during a take was asked in ${this.phase}${this.flipping ? ' (already flipping)' : ''} - ignored`
      );
      return;
    }
    const next = otherFacing(this.facing);
    const audio = current.getAudioTracks().filter((t) => t.readyState !== 'ended');
    const generation = ++this.#generation;
    console.debug(
      `[camera-session] flip to ${next} during a take, keeping ${audio.length} microphone track(s) (#${generation})`
    );
    this.#trackListeners?.abort();
    this.#trackListeners = null;
    for (const track of current.getVideoTracks()) track.stop();
    this.flipping = true;
    this.facing = next;
    this.torchOn = false;
    this.torchAvailable = false;
    try {
      const lens = await this.#openLens(next, true);
      if (generation !== this.#generation) {
        console.debug(`[camera-session] #${generation} lens came back after the session moved on`);
        releaseCamera(lens);
        return;
      }
      const stream = new MediaStream([...lens.getVideoTracks(), ...audio]);
      this.stream = stream;
      this.flipping = false;
      this.#install(stream, generation);
    } catch (err) {
      if (generation !== this.#generation) return;
      const fault = err instanceof CameraAccessError ? err.fault : 'unavailable';
      console.error(
        `[camera-session] #${generation} the other lens did not open during a take (${fault})`,
        err
      );
      ++this.#generation;
      this.#releaseCurrent();
      this.fault = fault;
      this.phase = 'error';
    }
  }

  /**
   * Moves the zoom to `level`, clamped to the lens's range. A HARDWARE lens is asked through its track
   * (one request in flight, the latest level wins, so a drag never queues a backlog); a DIGITAL lens
   * only changes {@link zoom}, which the preview and the captures read.
   */
  setZoom(level: number): void {
    if (this.#zoomRefused) return;
    const next = clampZoom(level, this.zoomRange);
    if (next === this.zoom) return;
    this.zoom = next;
    if (this.zoomRange.mode !== 'hardware') return;
    this.#zoomWanted = next;
    if (!this.#zoomApplying) void this.#applyHardwareZoom();
  }

  /** Back to 1x (a new take). */
  resetZoom(): void {
    this.setZoom(restingZoom(this.zoomRange));
  }

  async #applyHardwareZoom(): Promise<void> {
    this.#zoomApplying = true;
    try {
      while (this.#zoomWanted !== null) {
        const level = this.#zoomWanted;
        this.#zoomWanted = null;
        const track = this.stream?.getVideoTracks()[0];
        if (!track || this.flipping) return;
        const generation = this.#generation;
        try {
          await track.applyConstraints({ advanced: [{ zoom: level } as MediaTrackConstraintSet] });
        } catch (err) {
          // A request still running when a flip, a reopen or a stop took its lens away is rejected
          // by a track that is GONE: that is no refusal of the lens now in hand, so nothing is
          // accused or changed, and a level the new lens asked for meanwhile is still applied.
          if (generation !== this.#generation || this.flipping) {
            console.debug(
              `[camera-session] a zoom request of #${generation} ended with its lens (now #${this.#generation})`
            );
            continue;
          }
          // The track listed a zoom it then refused: said once for this lens, and its zoom stays put.
          console.error('[camera-session] the lens refused its own zoom capability', err);
          this.#zoomRefused = true;
          this.#zoomWanted = null;
          // The level shown is the track's own, never the one it refused.
          const actual = (track.getSettings?.() as { zoom?: number } | undefined)?.zoom;
          this.zoom = actual ?? restingZoom(this.zoomRange);
          return;
        }
      }
    } finally {
      this.#zoomApplying = false;
    }
  }

  /**
   * Takes `stream` as the session's: the torch and the zoom read from its lens, the zoom back to 1x,
   * and the `ended` listeners of its tracks. Shared by an open and a flip during a take.
   */
  #install(stream: MediaStream, generation: number): void {
    const lens = stream.getVideoTracks()[0];
    this.torchAvailable = torchSupported(lens);
    this.#installZoom(lens);
    const listening = new AbortController();
    this.#trackListeners = listening;
    // THE OS CAN TAKE THE LENS BACK under a live preview - another app opening the camera, the
    // permission revoked in the settings. The track then ENDS, and a session still saying `live`
    // would draw a frozen frame with an armed shutter. The end is the fact; it is read here. It
    // does not say WHICH of the two took it, so the fault says only that the camera was
    // interrupted - never "busy", which would be a guess.
    lens?.addEventListener?.(
      'ended',
      () => {
        if (generation !== this.#generation) return;
        console.warn(`[camera-session] #${generation} the lens ended under a live preview`);
        ++this.#generation;
        this.#releaseCurrent();
        this.fault = 'interrupted';
        this.phase = 'error';
      },
      { signal: listening.signal }
    );
    // The microphone can end the same way while the lens stays: the session then films no more.
    const live = stream.getAudioTracks().filter((t) => t.readyState !== 'ended');
    this.microphone = live.length > 0;
    for (const track of live) {
      track.addEventListener?.(
        'ended',
        () => {
          if (generation !== this.#generation) return;
          console.warn(`[camera-session] #${generation} the microphone ended - photos only`);
          this.microphone = false;
        },
        { signal: listening.signal }
      );
    }
  }

  /**
   * Reads the new lens's zoom and rests it at 1x. The MODE is logged once per session and mode at
   * info - it is a fact of the device worth one line, never one per gesture.
   */
  #installZoom(lens: MediaStreamTrack | undefined): void {
    const range = zoomRangeFor(lens);
    this.zoomRange = range;
    this.#zoomWanted = null;
    this.#zoomRefused = false;
    if (!this.#zoomModesLogged[range.mode]) {
      this.#zoomModesLogged[range.mode] = true;
      console.info(
        `[camera-session] zoom is ${range.mode} on the ${this.facing} lens (${range.min}x-${range.max}x)`
      );
    }
    const rest = restingZoom(range);
    this.zoom = rest;
    const current = (lens?.getSettings?.() as { zoom?: number } | undefined)?.zoom;
    if (range.mode === 'hardware' && current !== undefined && current !== rest) {
      this.#zoomWanted = rest;
      if (!this.#zoomApplying) void this.#applyHardwareZoom();
    }
  }

  /**
   * Lights or puts out the torch. A refusal is logged and leaves the state as the track says - the
   * button never claims a light that is not on.
   */
  async toggleTorch(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || !this.torchAvailable) {
      console.warn('[camera-session] torch asked for with no torch on this lens');
      return;
    }
    const want = !this.torchOn;
    try {
      await setTorch(track, want);
      this.torchOn = want;
    } catch (err) {
      console.error('[camera-session] the torch refused', err);
    }
  }

  /**
   * The app left the screen.
   *
   * AN OPEN IN FLIGHT IS NOT CANCELLED. On Android the system PERMISSION DIALOG itself sends the app to
   * the background, so stopping here threw away the request the dialog was answering - its refusal
   * came back to a stale generation and was dropped - and the return to the screen opened the camera
   * again, which raised the dialog a SECOND time (Mi 9T, v1.2.9-alpha.1). The request's answer is the
   * fact; it is awaited ({@link start} reads {@link #suspended} when it lands). Anything already open
   * is given back, as before.
   */
  suspend(): void {
    if (this.phase === 'starting') {
      console.debug('[camera-session] app away with an open in flight - its answer is awaited');
      this.#suspended = true;
      return;
    }
    this.stop();
  }

  /**
   * The app is back on screen: the camera opens again if the background closed it. An open still in
   * flight (the permission dialog just closed) is left to land, and a refusal stays the refusal.
   */
  resume(): void {
    if (this.#suspended) {
      console.debug('[camera-session] back on screen - the open in flight is kept');
      this.#suspended = false;
      return;
    }
    if (this.phase !== 'stopped') {
      console.debug(`[camera-session] back on screen in ${this.phase} - nothing to reopen`);
      return;
    }
    console.debug('[camera-session] back on screen - reopening');
    void this.start();
  }

  /** Gives the camera back - leaving the tab, or the app going to the background. */
  stop(): void {
    ++this.#generation;
    this.#suspended = false;
    console.debug('[camera-session] stop');
    this.#deviceWatch?.abort();
    this.#deviceWatch = null;
    this.#releaseCurrent();
    this.phase = 'stopped';
  }

  #releaseCurrent(): void {
    this.#trackListeners?.abort();
    this.#trackListeners = null;
    releaseCamera(this.stream);
    this.stream = null;
    this.microphone = false;
    this.torchOn = false;
    this.torchAvailable = false;
    this.flipping = false;
    this.#zoomWanted = null;
    this.zoom = restingZoom(this.zoomRange);
  }
}

/** The lens on the other side of the phone. */
function otherFacing(facing: CameraFacing): CameraFacing {
  return facing === 'environment' ? 'user' : 'environment';
}
