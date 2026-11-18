import type { HistorySealEngine } from '$lib/crypto/historySeal';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { invoke } from '@tauri-apps/api/core';

/**
 * The sealed history answer's HPKE operations answered by the native engine - the same `mls-core`
 * code the web runs as WASM (`history_seal.rs`), behind Tauri commands. Stateless, like
 * `tauriGraineSignatureEngine`: no MLS client, no group. Every value crosses the bridge as ONE base64
 * string - a chunk is up to 200 messages, and a number per byte is what made an invoke cost
 * (durable-rules, "an IPC bridge serialises"). The commands reject with the engine's bare code.
 */
export function tauriHistorySealEngine(): HistorySealEngine {
  return {
    async newAnswerKeyPair() {
      const pair = await invoke<{ secret: string; public: string }>('history_answer_keypair');
      return { secret: fromBase64(pair.secret), publicKey: fromBase64(pair.public) };
    },
    async seal(publicKey, aad, plaintext) {
      return fromBase64(
        await invoke<string>('seal_history_answer', {
          publicKeyB64: toBase64(publicKey),
          aadB64: toBase64(aad),
          plaintextB64: toBase64(plaintext),
        })
      );
    },
    async open(secret, aad, sealed) {
      return fromBase64(
        await invoke<string>('open_history_answer', {
          secretB64: toBase64(secret),
          aadB64: toBase64(aad),
          sealedB64: toBase64(sealed),
        })
      );
    },
  };
}
