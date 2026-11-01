/**
 * THE CALL MICROPHONE'S NOISE SUPPRESSOR - an AudioWorklet processor running RNNoise (xiph,
 * BSD-3-Clause) compiled to WebAssembly by `simple-rnnoise-wasm` (MIT, pinned in `package.json`,
 * bundled with the app: no CDN). It sits AFTER the browser's echo canceller, on the capture the
 * engine already processed (`utils/callAudio.ts`), and its output is the track the call sends
 * (`utils/callNoiseSuppression.ts`).
 *
 * RNNoise runs at 48 kHz on 10 ms frames of 480 samples; the engine hands a worklet 128-sample
 * quanta. The wasm's own `pipe` buffers the quanta into frames and returns the processed samples
 * once a whole frame is ahead (4 quanta, ~10.7 ms of added latency).
 *
 * WHAT IT TELLS THE PAGE, on its port - never a sample:
 * - `ready` once the wasm is instantiated AND the first input quantum went through it: the proof
 *   the page waits for before the call sends this node's output (a node that never processes would
 *   send silence);
 * - `error` with the cause, when the scope lacks WebAssembly or the module does not instantiate -
 *   the page then keeps the raw track and says so;
 * - `stats` every {@link STATS_EVERY_FRAMES} frames: frames processed and the time spent in them,
 *   on the clock this scope has (`performance.now()` where the scope exposes it, else `Date.now()`,
 *   whose 1 ms steps still average to the right mean over thousands of quanta: the step's phase
 *   against a quantum's start is uniform).
 *
 * No import: an AudioWorkletGlobalScope has no `fetch`, no `self`, no DOM, and the bundle must load
 * there as it is (`workerScope.test.ts` loads it in such a scope).
 */

/** The processor name the page constructs (`CALL_NOISE_SUPPRESSOR_PROCESSOR`). */
const PROCESSOR = 'canari-rnnoise';
/** RNNoise's frame: 10 ms at 48 kHz. */
const FRAME = 480;
/** ~5 s of audio between two `stats` messages. */
const STATS_EVERY_FRAMES = 500;

// The AudioWorkletGlobalScope, which no TypeScript lib describes.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(
  name: string,
  ctor: new (options: { processorOptions?: { wasm?: ArrayBuffer } }) => AudioWorkletProcessor
): void;

/** The exports of `simple-rnnoise-wasm/rnnoise.wasm` (no imports; one fixed memory). */
interface RnnoiseExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  newState(): number;
  deleteState(state: number): void;
  getInput(state: number): number;
  pipe(state: number, length: number): number;
}

type Clock = { name: 'performance' | 'date'; now: () => number };

/** The best clock this scope has: a worklet scope may expose `performance`, and may not. */
function scopeClock(): Clock {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function')
    return { name: 'performance', now: () => perf.now!() };
  return { name: 'date', now: () => Date.now() };
}

class RnnoiseProcessor extends AudioWorkletProcessor {
  private wasm: RnnoiseExports | null = null;
  private heap: Float32Array | null = null;
  private state = 0;
  private alive = true;
  private readySent = false;
  private readonly clock = scopeClock();
  private samples = 0;
  private busy = 0;
  private maxQuantum = 0;
  private nextStatsAt = STATS_EVERY_FRAMES * FRAME;

  constructor(options: { processorOptions?: { wasm?: ArrayBuffer } }) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'destroy') this.destroy();
    };
    const bytes = options.processorOptions?.wasm;
    if (typeof WebAssembly !== 'object') {
      this.fail('this AudioWorklet scope has no WebAssembly');
      return;
    }
    if (!(bytes instanceof ArrayBuffer)) {
      this.fail('no wasm bytes in processorOptions');
      return;
    }
    if (sampleRate !== 48_000) {
      this.fail(`the context runs at ${sampleRate} Hz, RNNoise needs 48000`);
      return;
    }
    WebAssembly.instantiate(bytes, {}).then(
      ({ instance }) => {
        if (!this.alive) return;
        const wasm = instance.exports as unknown as RnnoiseExports;
        wasm._initialize?.();
        this.state = wasm.newState();
        this.heap = new Float32Array(wasm.memory.buffer);
        this.wasm = wasm;
      },
      (error: unknown) => this.fail(`the wasm did not instantiate: ${String(error)}`)
    );
  }

  private fail(detail: string): void {
    this.alive = false;
    this.port.postMessage({ type: 'error', detail });
  }

  private destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    if (this.wasm && this.state) this.wasm.deleteState(this.state);
    this.wasm = null;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.alive) return false;
    const out = outputs[0]?.[0];
    const input = inputs[0]?.[0];
    const wasm = this.wasm;
    const heap = this.heap;
    // Not instantiated yet, or no input connected this quantum: silence (the engine zeroed `out`).
    if (!out || !input || !wasm || !heap) return true;
    const t0 = this.clock.now();
    heap.set(input, wasm.getInput(this.state) >> 2);
    const at = wasm.pipe(this.state, input.length) >> 2;
    if (at) out.set(heap.subarray(at, at + out.length));
    const spent = this.clock.now() - t0;
    this.busy += spent;
    if (spent > this.maxQuantum) this.maxQuantum = spent;
    this.samples += input.length;
    if (!this.readySent) {
      this.readySent = true;
      this.port.postMessage({ type: 'ready', clock: this.clock.name });
    }
    if (this.samples >= this.nextStatsAt) {
      this.nextStatsAt += STATS_EVERY_FRAMES * FRAME;
      this.port.postMessage({
        type: 'stats',
        frames: Math.floor(this.samples / FRAME),
        busyMs: this.busy,
        maxQuantumMs: this.maxQuantum,
        clock: this.clock.name,
      });
    }
    return true;
  }
}

registerProcessor(PROCESSOR, RnnoiseProcessor);
