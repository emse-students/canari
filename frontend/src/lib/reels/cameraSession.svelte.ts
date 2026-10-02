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
  facing = $state<CameraFacing>('environment');
  stream = $state.raw<MediaStream | null>(null);
  torchOn = $state(false);
  /** Read from the open track, never assumed: the front lenses measured have no torch. */
  torchAvailable = $state(false);

  /** Bumped by every open and every stop; an acquisition that returns to another number is stale. */
  #generation = 0;
  readonly #open: CameraOpener;

  constructor(open: CameraOpener = openReelCamera) {
    this.#open = open;
  }

  /** Opens `facing` (the current lens by default), releasing whatever was open first. */
  async start(facing: CameraFacing = this.facing): Promise<void> {
    const generation = ++this.#generation;
    console.debug(`[camera-session] start ${facing} (#${generation})`);
    this.#releaseCurrent();
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
      this.stream = stream;
      this.torchAvailable = torchSupported(stream.getVideoTracks()[0]);
      this.phase = 'live';
    } catch (err) {
      if (generation !== this.#generation) return;
      const fault = err instanceof CameraAccessError ? err.fault : 'unavailable';
      if (!(err instanceof CameraAccessError)) {
        console.error('[camera-session] the opener threw something untyped', err);
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

  /** Gives the camera back - leaving the tab, or the app going to the background. */
  stop(): void {
    ++this.#generation;
    console.debug('[camera-session] stop');
    this.#releaseCurrent();
    this.phase = 'stopped';
  }

  #releaseCurrent(): void {
    releaseCamera(this.stream);
    this.stream = null;
    this.torchOn = false;
    this.torchAvailable = false;
  }
}
