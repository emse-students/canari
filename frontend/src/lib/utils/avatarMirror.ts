import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * Hands a face the app has just drawn to the Android notification's avatar cache.
 *
 * ONE CACHE, ONE READER. The FCM service draws a notification's face from
 * `files/avatar_<id>.jpg` before it asks the network, and until this existed only the service
 * itself ever wrote that file - so a contact the user had seen a minute earlier still showed
 * initials whenever the push arrived on a bad network (2026-10-01). The foreground already holds
 * those bytes; `store_avatar_mirror` (Rust, `commands/notifications.rs`) writes them where the
 * notification reads.
 *
 * The bytes go as a plain array, like `save_mls_state`'s: Android's IPC turns a typed array into
 * JSON whatever the caller passes, and a raw-body version was refused on the Mi 9T.
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
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const data = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invoke('store_avatar_mirror', { userId, data });
    Log.d('AvatarMirror', `mirrored ${userId.slice(0, 8)} (${data.length} bytes)`);
  } catch (e) {
    console.warn(`[AVATAR_MIRROR] store failed for ${userId.slice(0, 8)}: ${String(e)}`);
  }
}
