/**
 * Empties the cache's `share_out/` at sign-out: the decrypted file the last share left there
 * (`shareOut.ts`) must not outlive the session it was decrypted in.
 *
 * Kept apart from `shareOut.ts` because `stores/auth` calls it, and `shareOut.ts` reaches the media
 * cache, which imports `stores/auth`. See `docs/wiki/frontend/share-out.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { galleryCommand } from '$lib/services/galleryCommands';
import { hasNativeGallery } from '$lib/reels/gallery';

/** Empties `share_out/` on a phone; nothing elsewhere. A failure is said, never thrown. */
export async function discardSharedOut(reason: string): Promise<void> {
  if (!hasNativeGallery()) return;
  console.debug(`[share-out] emptying share_out (${reason})`);
  try {
    await invoke(galleryCommand('discardSharedOut'));
  } catch (err) {
    console.error(`[share-out] share_out was not emptied (${reason})`, err);
  }
}
