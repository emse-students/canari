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
  openReelCamera,
  releaseCamera,
  setTorch,
  torchSupported,
  type CameraFacing,
  type CameraFault,
} from './cameraAccess';

/** Where the preview stands. */
export type CameraPhase = 'starting' | 'live' | 'error' | 'stopped';

/** The opener, injectable so the session's ordering can be tested without a camera. */
export type CameraOpener = (facing: CameraFacing) => Promise<MediaStream>;

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

  constructor(open: CameraOpener = openReelCamera) {
    this.#open = open;
  }

  /** Opens `facing` (the current lens by default), releasing whatever was open first. */
  async start(facing: CameraFacing = this.facing): Promise<void> {
    const generation = ++this.#generation;
    console.debug(`[camera-session] start ${facing} (#${generation})`);
    this.#releaseCurrent();
    this.#suspended = false;
    this.facing = facing;
    this.phase = 'starting';
    this.fault = null;
    try {
      const stream = await this.#open(facing);
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
      const lens = stream.getVideoTracks()[0];
      this.torchAvailable = torchSupported(lens);
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
      this.phase = 'live';
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

  /** The other lens. The recorder never calls this while it records: a track cannot be swapped mid-file. */
  switchFacing(): Promise<void> {
    const next: CameraFacing = this.facing === 'environment' ? 'user' : 'environment';
    console.debug(`[camera-session] switch to ${next}`);
    return this.start(next);
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
  }
}
