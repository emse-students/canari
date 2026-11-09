/**
 * THE LIVE'S PREVIEW IMAGE, BROADCASTER SIDE (owner, 2026-11-07): a still frame of what is on air,
 * sent every few segments so the feed card shows the stream, not just a line.
 *
 * THE CADENCE IS THE SEGMENT INDEX, NEVER A TIMER. A poster goes when segment `index` is enqueued
 * with `index % everySegments === 0` ({@link posterEverySegments}: the server's ONE preview period in
 * this client's 2 s segments - 8 for 16 s; segment 0 first). The index is durable - the server's
 * `nextIndex` - so a camera paused in the
 * background sends no segment and therefore no poster: the card keeps the last image and says how
 * old it is (the server's `posterAt`). A missed or refused upload only means a staler image; nothing
 * is retried, because the next one is a few segments away.
 *
 * ONE AT A TIME: a capture still running when the next turn comes is not doubled - that turn is
 * skipped and logged. The server holds the same bound (`LIVE_POSTER_MIN_INTERVAL_MS`, 429).
 *
 * THE FRAME: a canvas grab of the screen's own preview `<video>` (the same picture the broadcaster
 * sees, the camera or a shared screen), {@link LIVE_POSTER_WIDTH_PX} wide, JPEG at
 * {@link LIVE_POSTER_JPEG_QUALITY}. JPEG and nothing else: every engine encodes it from a canvas
 * (WebKit has no WebP encoder) and every viewer decodes it, so there is one path and no fallback.
 */

import { isTransportFailure } from '$lib/utils/transportFailure';
import { isLiveRefusal, LiveRefusalError } from './api';
import { LIVE_SEGMENT_MS } from './constants';

/** The preview's width in pixels; the height follows the frame's aspect. */
export const LIVE_POSTER_WIDTH_PX = 480;

/** The JPEG quality asked of the canvas. */
export const LIVE_POSTER_JPEG_QUALITY = 0.7;

/**
 * The server's preview period (`previewPeriodMs`) as a number of THIS client's segments
 * ({@link LIVE_SEGMENT_MS}): the cadence stays on the durable segment index, and the feed card,
 * which reads once per period, sees every poster sent. At least one.
 */
export function posterEverySegments(previewPeriodMs: number): number {
  return Math.max(1, Math.round(previewPeriodMs / LIVE_SEGMENT_MS));
}

/**
 * Grabs the frame the `<video>` shows now as a JPEG {@link LIVE_POSTER_WIDTH_PX} wide (never wider
 * than the frame itself). `null` when there is no frame yet (the element not playing) or the
 * engine produced no image - logged, and the turn is simply skipped.
 */
export async function grabPosterFrame(
  video: HTMLVideoElement,
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')
): Promise<Uint8Array | null> {
  const { videoWidth, videoHeight } = video;
  if (video.readyState < 2 || videoWidth === 0 || videoHeight === 0) {
    console.debug('[LIVE-POSTER] no frame to grab yet - this turn is skipped');
    return null;
  }
  const width = Math.min(LIVE_POSTER_WIDTH_PX, videoWidth);
  const height = Math.max(1, Math.round((videoHeight * width) / videoWidth));
  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    console.warn('[LIVE-POSTER] the canvas gave no 2d context - no preview this turn');
    return null;
  }
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', LIVE_POSTER_JPEG_QUALITY)
  );
  if (!blob) {
    console.warn('[LIVE-POSTER] the canvas encoded no image - no preview this turn');
    return null;
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/** What the sender reaches outside itself. */
export interface LivePosterSenderDeps {
  /** The current frame as JPEG bytes, or null when there is none. */
  capture: () => Promise<Uint8Array | null>;
  /** Seals the bytes under the POSTER key (derived from the live key, never the live key itself). */
  seal: (plain: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
  /** Uploads the sealed bytes (`PUT /api/lives/:id/poster`). */
  put: (sealed: Uint8Array<ArrayBuffer>) => Promise<unknown>;
  /** A poster every this many segments ({@link posterEverySegments}). */
  everySegments: number;
  /** The server's bound on the sealed bytes; a larger frame is not sent. */
  maxBytes: number;
}

/** How one turn ended - what a test reads, and what the log line names. */
export type LivePosterTurn =
  | 'sent'
  | 'not-due'
  | 'busy'
  | 'stopped'
  | 'no-frame'
  | 'too-large'
  | 'ended'
  | 'refused'
  | 'offline'
  | 'failed';

/**
 * Sends the live's preview image on the segment cadence (see the module comment). Constructed when
 * the live starts, told of every segment the pipeline enqueues ({@link onSegment}), stopped when the
 * screen gives everything back.
 */
export class LivePosterSender {
  readonly #deps: LivePosterSenderDeps;
  #inFlight: Promise<LivePosterTurn> | null = null;
  #stopped = false;
  #sent = 0;

  constructor(deps: LivePosterSenderDeps) {
    this.#deps = deps;
  }

  /**
   * Segment `index` was enqueued: a poster when the index is on the cadence and none is in flight.
   * Never awaited by the segment path - the video never waits for its preview. Answers the turn's
   * promise (for tests) or the reason no turn was taken.
   */
  onSegment(index: number): Promise<LivePosterTurn> {
    if (this.#stopped) return Promise.resolve('stopped');
    if (index % this.#deps.everySegments !== 0) return Promise.resolve('not-due');
    if (this.#inFlight) {
      console.debug(
        `[LIVE-POSTER] segment ${index}: the previous preview is still going - skipped`
      );
      return Promise.resolve('busy');
    }
    const turn = this.#send(index).finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = turn;
    return turn;
  }

  /** No poster after this - the live ended or the screen closed. Idempotent. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    console.debug(`[LIVE-POSTER] stopped after ${this.#sent} preview(s)`);
  }

  async #send(index: number): Promise<LivePosterTurn> {
    try {
      const frame = await this.#deps.capture();
      if (this.#stopped) return 'stopped';
      if (!frame) return 'no-frame';
      const sealed = await this.#deps.seal(frame);
      if (sealed.byteLength > this.#deps.maxBytes) {
        console.warn(
          `[LIVE-POSTER] segment ${index}: the preview is ${sealed.byteLength} B, over the server's ${this.#deps.maxBytes} - not sent`
        );
        return 'too-large';
      }
      if (this.#stopped) return 'stopped';
      await this.#deps.put(sealed);
      this.#sent += 1;
      console.debug(`[LIVE-POSTER] segment ${index}: preview sent (${sealed.byteLength} B)`);
      return 'sent';
    } catch (e) {
      if (isLiveRefusal(e, 'ended') || isLiveRefusal(e, 'not-found')) {
        // The live is over: the segment path hears the same verdict and ends the screen.
        console.debug(`[LIVE-POSTER] segment ${index}: the live is over - no more previews`);
        this.stop();
        return 'ended';
      }
      if (isTransportFailure(e)) {
        console.log(`[LIVE-POSTER] segment ${index}: no answer - the next preview will try`);
        return 'offline';
      }
      if (e instanceof LiveRefusalError) {
        console.warn(`[LIVE-POSTER] segment ${index}: refused (${String(e)}) - a staler image`);
        return 'refused';
      }
      console.error(`[LIVE-POSTER] segment ${index}: the preview failed`, e);
      return 'failed';
    }
  }
}
