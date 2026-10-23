import type { GraineSignatureEngine, GraineSignatureVerdict } from '$lib/crypto/graineV2';
import { invoke } from '@tauri-apps/api/core';

/**
 * Graine's Ed25519 operations answered by the native engine - the same `mls-core` code the web runs
 * as WASM, behind Tauri commands. Stateless: no MLS client, no device, no group, which is why it
 * lives outside `TauriMlsService` and can be reached before one exists.
 */
export function tauriGraineSignatureEngine(): GraineSignatureEngine {
  return {
    async newSessionKeyPair() {
      const pair = await invoke<{ secret: number[]; public: number[] }>('graine_session_keypair');
      return { secret: new Uint8Array(pair.secret), publicKey: new Uint8Array(pair.public) };
    },
    async signWithSessionKey(secret, message) {
      return new Uint8Array(
        await invoke<number[]>('graine_sign_with_session_key', {
          secret: Array.from(secret),
          message: Array.from(message),
        })
      );
    },
    verifySignature(publicKey, message, signature) {
      return invoke<GraineSignatureVerdict>('graine_verify_signature', {
        publicKey: Array.from(publicKey),
        message: Array.from(message),
        signature: Array.from(signature),
      });
    },
  };
}
