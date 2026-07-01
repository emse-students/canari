/**
 * Channel key native mirror - lets the Android background service (app killed) decrypt incoming
 * channel-message push notifications without reopening the app.
 *
 * Channel messages are AES-256-GCM encrypted with a per-epoch key. The TypeScript ChannelKeyVault
 * is the source of truth; this module additionally writes each raw epoch key to an app-private file
 * (`channel_keys.json`, a map `channelId -> { keyVersion -> base64(rawKey) }`) so the native side can
 * AES-GCM-decrypt the inline ciphertext locally. The key is the final 32-byte epoch key (no KDF to
 * replicate natively), mirroring the outbox/MLS native-mirror posture.
 *
 * Security note: the file is plaintext app-private storage, consistent with `push_context.json`
 * (stores the PIN) and `mls.bin`. The epoch key never leaves the device; the ciphertext travelling
 * in the push lets the device decrypt locally so Google/FCM never sees the plaintext.
 */

import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';
import { isTauriRuntime } from '$lib/utils/openExternal';

/** Strip the `channel_` prefix so the mirror is keyed by the raw UUID the push carries. */
function rawChannelId(channelId: string): string {
  return String(channelId).replace(/^channel_/, '');
}

/**
 * Persists one channel epoch key into the native mirror (`channel_keys.json`). Tauri only; a no-op
 * on web. Best-effort: a failed mirror only means a richer notification falls back to a generic one.
 */
export async function mirrorChannelKey(
  channelId: string,
  keyVersion: number,
  rawKeyMaterial: Uint8Array
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const keyB64 = btoa(String.fromCharCode(...rawKeyMaterial));
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_channel_key', {
      channelId: rawChannelId(channelId),
      keyVersion,
      keyB64,
    });
  } catch (e) {
    console.warn(
      `[CHANNEL_KEY_MIRROR] store failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Imports an epoch key into the in-memory vault AND mirrors it to the native store. Single entry
 * point so every key load (bootstrap, key distribution, history hydration) keeps the native mirror
 * in sync without duplicating the rotate+mirror pair at each call site.
 */
export async function importChannelEpochKey(
  channelId: string,
  keyVersion: number,
  rawKeyMaterial: Uint8Array
): Promise<void> {
  await channelKeyManager.getVault(rawChannelId(channelId)).rotateKey(keyVersion, rawKeyMaterial);
  await mirrorChannelKey(channelId, keyVersion, rawKeyMaterial);
}
