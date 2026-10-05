/**
 * One take of a CanaReel: `MediaRecorder` over the camera's stream, until the shutter or the 90 s cap
 * ends it (R3, decision C4).
 *
 * THE DEVICE IS NOT ITS TO RELEASE. The stream belongs to the camera session, which keeps the preview
 * running after a take so a retake is one press away; this only records what flows through it.
 *
 * Every failure is a {@link ReelRecorderError} with its fault, classified where it happened, so the
 * screen never reads a message.
 */

import { pausePlayback } from '$lib/actions/playbackArbiter';
import { pickReelRecorderMime } from './reelCapture';
import { REEL_RECORD_BITRATE_MAX } from './framedCapture';

/** How often the recorder hands over a chunk, so a long take is not one buffer at the end. */
const CHUNK_MS = 1000;

export type ReelRecorderFault =
  /** This engine records none of the containers asked for. */
  | 'unsupported'
  /** The recorder refused to start on this stream. */
  | 'start'
  /** It failed mid-take. */
  | 'record'
  /** It stopped with no bytes. */
  | 'empty';

export class ReelRecorderError extends Error {
  constructor(
    readonly fault: ReelRecorderFault,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ReelRecorderError';
  }
}

export class ReelRecorder {
  readonly #recorder: MediaRecorder;
  readonly #mime: string;
  readonly #chunks: Blob[] = [];
  #failure: ReelRecorderError | null = null;
  readonly #startedAt: number;

  private constructor(recorder: MediaRecorder, mime: string) {
    this.#recorder = recorder;
    this.#mime = mime;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.#chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      console.error('[reel-recorder] failed mid-take', event);
      this.#failure = new ReelRecorderError('record', 'reel: the recorder failed', {
        cause: event,
      });
    };
    // The take records the room: a video or voice note playing would be in it.
    pausePlayback(undefined, false, 'reel recorder started');
    recorder.start(CHUNK_MS);
    this.#startedAt = performance.now();
  }

  /**
   * Starts recording `stream`.
   *
   * @param ios Whether this is the iOS app, which records MP4 (`reelRecorderMimeCandidates`).
   * @param bitrate Bits per second for the frame size actually recorded (`videoBitrateFor`); at most
   *   the cap above the 2.5 Mb/s upload target, so the preparation compresses once.
   * @throws {ReelRecorderError} `unsupported` or `start`.
   */
  static start(
    stream: MediaStream,
    ios: boolean,
    bitrate: number = REEL_RECORD_BITRATE_MAX
  ): ReelRecorder {
    const supported =
      typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
    const mime = supported
      ? pickReelRecorderMime(ios, (t) => MediaRecorder.isTypeSupported(t))
      : null;
    if (!mime) {
      console.warn('[reel-recorder] this engine records none of the reel containers');
      throw new ReelRecorderError('unsupported', 'reel: no recordable container');
    }
    try {
      const recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: bitrate,
      });
      console.debug(`[reel-recorder] recording ${mime} at ${bitrate} b/s`);
      return new ReelRecorder(recorder, mime);
    } catch (err) {
      console.error('[reel-recorder] could not start', err);
      throw new ReelRecorderError('start', 'reel: the recorder refused to start', { cause: err });
    }
  }

  /** Milliseconds since the take started. */
  get elapsedMs(): number {
    return performance.now() - this.#startedAt;
  }

  /**
   * Ends the take and hands over its bytes - once the LAST chunk has arrived, which is the recorder's
   * `stop` event and nothing earlier: stopping the stream before it would cut the tail of the take.
   *
   * @throws {ReelRecorderError} `record` if it failed mid-take, `empty` if it holds nothing.
   */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (this.#failure) return reject(this.#failure);
        const type = this.#recorder.mimeType || this.#mime;
        const blob = new Blob(this.#chunks, { type });
        if (blob.size === 0) {
          console.warn('[reel-recorder] the take is empty');
          return reject(new ReelRecorderError('empty', 'reel: the take is empty'));
        }
        console.debug(`[reel-recorder] take: ${blob.size} bytes, ${type}`);
        resolve(blob);
      };
      if (this.#recorder.state === 'inactive') {
        finish();
        return;
      }
      this.#recorder.onstop = finish;
      this.#recorder.stop();
    });
  }

  /** Throws the take away - the screen left mid-take. */
  abort(): void {
    console.debug('[reel-recorder] take abandoned');
    this.#recorder.ondataavailable = null;
    this.#recorder.onstop = null;
    if (this.#recorder.state !== 'inactive') this.#recorder.stop();
    this.#chunks.length = 0;
  }
}
