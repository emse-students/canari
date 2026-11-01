import rnnoiseWorkletUrl from '$lib/workers/rnnoise.worklet?worker&url';
import rnnoiseWasmUrl from 'simple-rnnoise-wasm/rnnoise.wasm?url';
import type { CallMicPipelineDeps } from './callNoiseSuppression';

/**
 * The platform half of `buildCallMicPipeline`'s dependencies: the worklet bundled by Vite and the
 * RNNoise wasm emitted as an asset of the app's own origin (no CDN; `script-src 'self'
 * 'wasm-unsafe-eval'` covers both). Kept apart so the builder is tested without Vite's queries.
 */
export function callMicPipelineDeps(log: (msg: string) => void): CallMicPipelineDeps {
  return {
    createContext: () => new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' }),
    workletUrl: rnnoiseWorkletUrl,
    loadWasm: async () => {
      const res = await fetch(rnnoiseWasmUrl);
      if (!res.ok) throw new Error(`GET rnnoise.wasm answered ${res.status}`);
      return res.arrayBuffer();
    },
    log,
  };
}
