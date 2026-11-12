/**
 * THE VOICE RECORDER'S LOUDNESS TAP - an AudioWorklet processor that hands the microphone's samples,
 * as they are recorded, to the page's `LoudnessMeter` (`utils/audio/recordingLoudness.ts`, owner
 * 2026-11-12). The meter is NOT here: there is ONE BS.1770 implementation (`video/loudnessMeter.ts`)
 * and it runs on the page; this only copies.
 *
 * The engine hands a worklet 128-frame quanta; they are gathered into batches of {@link BATCH_FRAMES}
 * frames (~43 ms at 48 kHz) and posted with their buffers TRANSFERRED, so the page receives ~23
 * messages a second and nothing is copied twice.
 *
 * The output is silence: the node is pulled through a `MediaStreamAudioDestinationNode` (the call
 * microphone's pattern, `callNoiseSuppression.ts`), never through the speaker.
 *
 * No import: an AudioWorkletGlobalScope has no `fetch`, no `self`, no DOM, and the bundle must load
 * there as it is (`workerScope.test.ts` loads it in such a scope).
 */

/** The processor name the page constructs (`LOUDNESS_TAP_PROCESSOR`). */
const PROCESSOR = 'canari-loudness-tap';
/** Frames gathered before one message to the page. */
const BATCH_FRAMES = 2048;

// The AudioWorkletGlobalScope, which no TypeScript lib describes.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** One batch, as the page receives it: one plane per channel, `frames` samples each. */
export interface LoudnessTapBatch {
  planes: Float32Array[];
  frames: number;
}

class LoudnessTapProcessor extends AudioWorkletProcessor {
  #planes: Float32Array[] = [];
  #fill = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    // No input connected (yet, or any more): nothing to copy, and the node stays alive.
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    if (this.#planes.length !== input.length) {
      // A channel-count change mid-recording: the partial batch is posted as it was gathered.
      this.#post();
      this.#planes = input.map(() => new Float32Array(BATCH_FRAMES));
    }
    let offset = 0;
    while (offset < frames) {
      const take = Math.min(frames - offset, BATCH_FRAMES - this.#fill);
      for (let c = 0; c < input.length; c++) {
        this.#planes[c].set(input[c].subarray(offset, offset + take), this.#fill);
      }
      this.#fill += take;
      offset += take;
      if (this.#fill === BATCH_FRAMES) this.#post();
    }
    return true;
  }

  #post(): void {
    if (this.#fill === 0 || this.#planes.length === 0) return;
    const planes = this.#planes.map((plane) => plane.slice(0, this.#fill));
    const batch: LoudnessTapBatch = { planes, frames: this.#fill };
    this.port.postMessage(
      batch,
      planes.map((plane) => plane.buffer)
    );
    this.#fill = 0;
  }
}

registerProcessor(PROCESSOR, LoudnessTapProcessor);
