import type { StoredGraineSession } from '$lib/db/types';
import { isTauriRuntime } from '$lib/utils/openExternal';

/**
 * Graine native mirror - lets the background push service derive a message key with the app killed.
 *
 * The durable store is the source of truth; this additionally writes each seed to an app-private
 * file (`graine_seeds.json`, a map `channelId -> { sessionId -> { seed, createdAt } }`) so the
 * native handlers can decrypt an inline push ciphertext before any WebView runs. The Rust side
 * keeps only the newest sessions per channel, which is the whole difference from the epoch mirror
 * it replaces: epoch keys were few, seeds accumulate for ever.
 *
 * Security posture: app-private plaintext, the same as `push_context.json` and `mls.bin`. The seed
 * never leaves the device; what travels in the push is a ciphertext the device opens locally, so
 * Google/FCM and Apple see nothing.
 */

/**
 * Mirrors one session's seed natively. Tauri only; a no-op on web.
 *
 * **Best-effort, and that is a real answer rather than a swallowed one:** a seed too old to be
 * mirrored, or a mirror that failed to write, costs a richer notification and nothing else - the
 * banner degrades to "new message in #salon", which is the existing behaviour for an oversized
 * ciphertext. It never costs a message: the WebView reads the durable store, not this file.
 */
export async function mirrorGraineSeed(session: StoredGraineSession): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_graine_seed', {
      channelId: session.channelId,
      sessionId: session.sessionId,
      seedB64: session.seedB64,
      createdAt: session.createdAt,
    });
  } catch (e) {
    console.warn(`[GRAINE_MIRROR] store failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
