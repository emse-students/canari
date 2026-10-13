import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { toBase64 } from '$lib/utils/hex';
import { Log } from '$lib/utils/Log';

/**
 * The bytes this process last handed to the native mirror, per face, as a SHA-256 digest - or the
 * pending write of them.
 *
 * WHY IT EXISTS (store `1.2.6`, Pixel 6a, 2026-10-13): every salon open re-mirrored every face in
 * it - 7/50/11/24 writes for four salons, identical on every repeat. The avatar URL answers
 * `no-cache` + ETag, so each mount revalidates (a `304`, read from the WebView's HTTP cache) and the
 * page receives the SAME bytes again; the blob pool drops a face with its last mount
 * (`userAvatarCache.ts`), so nothing remembered that they had already been written. Each write cost
 * ~8 ms of main thread on the Mi 9T (50 faces: 360-440 ms, the IPC serialising a number array).
 *
 * KEYED ON THE CONTENT, NOT ON A CLOCK: the same bytes are never written twice in one process, and
 * a changed photo (another digest) is written at once. The ETag would say the same thing, but a
 * cross-origin `fetch` cannot read it without an `Access-Control-Expose-Headers` nobody sends.
 *
 * Process-wide, and cleared only by {@link forgetMirroredAvatars}: it describes files on THIS
 * device, which outlive a sign-out but not the factory wipe (`clear_app_data` deletes every
 * `avatar_*`), so the wipe forgets them too - otherwise the next account signed in on the same
 * process would never be mirrored a face this memory still called written. What it gives up: the first write of a face per process refreshes the file's mtime, which the
 * notification reader ages at 24 h (`write_avatar_mirror`), so a process alive for over a day lets
 * the shade fall back to the network for a face it has kept drawing - the cost before any mirror.
 */
const mirrored = new Map<string, Promise<string | null>>();

/** Lowercase hex SHA-256 of `bytes` - the identity of one photo, whoever's it is. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hands a face the app has just drawn to the Android notification's avatar cache.
 *
 * ONE CACHE, ONE READER. The FCM service draws a notification's face from
 * `files/avatar_<id>.jpg` before it asks the network, and until this existed only the service
 * itself ever wrote that file - so a contact the user had seen a minute earlier still showed
 * initials whenever the push arrived on a bad network (2026-10-01). The foreground already holds
 * those bytes; `store_avatar_mirror` (Rust, `commands/notifications.rs`) writes them where the
 * notification reads. A face whose bytes this process already wrote is not written again
 * ({@link mirrored}).
 *
 * The bytes go as ONE base64 string. Android's IPC is JSON whatever the caller passes (a raw-body
 * version was refused on the Mi 9T), and a JSON number array costs ~3.6 characters per byte and
 * an `Array.from` of every byte on the main thread: 50 faces of 7.5 KB took 360-440 ms of main
 * thread as an array and 130-150 ms as base64 (Mi 9T, 2026-10-13).
 *
 * Android only: the iOS extension reads an app-group container this does not write. Best-effort,
 * and the failure is a real answer rather than a swallowed one: it costs the notification a
 * request, which is exactly what it cost before, never the face on screen.
 *
 * @param userId whose face it is - the fact the caller already holds, never parsed from a URL.
 * @param blob the bytes the `<img>` is about to draw.
 */
export async function mirrorAvatarToNative(userId: string, blob: Blob): Promise<void> {
  if (!userId.trim() || !isAndroidTauriRuntime()) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let digest: string;
  try {
    digest = await digestOf(bytes);
  } catch (e) {
    console.warn(`[AVATAR_MIRROR] digest failed for ${userId.slice(0, 8)}: ${String(e)}`);
    return;
  }
  const previous = mirrored.get(userId);
  if (previous && (await previous) === digest) return;

  const write = storeMirror(userId, bytes).then((ok) => (ok ? digest : null));
  mirrored.set(userId, write);
  // A FAILED WRITE LEAVES NOTHING BEHIND, so the next draw of the face tries again rather than
  // trusting a file that was never written.
  if ((await write) === null && mirrored.get(userId) === write) mirrored.delete(userId);
}

/** One write through the native command; true when it landed. */
async function storeMirror(userId: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_avatar_mirror', { userId, dataB64: toBase64(bytes) });
    Log.d('AvatarMirror', `mirrored ${userId.slice(0, 8)} (${bytes.length} bytes)`);
    return true;
  } catch (e) {
    console.warn(`[AVATAR_MIRROR] store failed for ${userId.slice(0, 8)}: ${String(e)}`);
    return false;
  }
}

/**
 * Forgets every face this process wrote, as a new process would. Called by the factory wipe right
 * after `clear_app_data` has deleted the files themselves (`deviceReset.ts`).
 */
export function forgetMirroredAvatars(): void {
  Log.d('AvatarMirror', `forgetting ${mirrored.size} mirrored faces`);
  mirrored.clear();
}
