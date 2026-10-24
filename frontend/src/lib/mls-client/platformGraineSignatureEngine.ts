import type { GraineSignatureEngine } from '$lib/crypto/graineV2';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';
import { wasmGraineSignatureEngine } from './mlsWasmLoader';
import { tauriGraineSignatureEngine } from './tauriGraineSignatureEngine';

/**
 * This platform's Graine signature engine, for a caller that holds no MLS client: redeeming an
 * invite link's admission proof (channel-encryption section 25) happens when joining, before the
 * messaging layer may be up - a first sign-in on a new device is exactly that case - and needs only
 * Ed25519.
 */
export function platformGraineSignatureEngine(): GraineSignatureEngine {
  return isTauriRuntime() ? tauriGraineSignatureEngine() : wasmGraineSignatureEngine();
}
