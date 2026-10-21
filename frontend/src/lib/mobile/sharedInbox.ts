/**
 * Deletes the on-disk copies of a share INTO Canari that will never be staged.
 *
 * While the app runs, a copy is deleted by whoever ends its share: `take_picked_file` as the chat
 * page reads it, or this, when the page drops it unread - the member dismissed the picker, a newer
 * share replaced it, or it is over the upload ceiling. Without it, a dropped share's copies (up to
 * 300 MB) would sit in the cache until the next process start sweeps them. Kept apart from
 * `incomingShareDrain` so the store can call it without an import cycle.
 * See `docs/wiki/frontend/sharing.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { Log } from '$lib/utils/Log';

/** Deletes each copy unread; a copy that cannot be deleted is said, never thrown. */
export async function discardSharedFiles(paths: string[], reason: string): Promise<void> {
  if (paths.length === 0) return;
  Log.d('IncomingShare', `discarding ${paths.length} copy(ies): ${reason}`);
  for (const path of paths) {
    try {
      await invoke('discard_picked_file', { path });
    } catch (error) {
      console.error(`[SHARE] a shared copy was not discarded (${reason}): ${String(error)}`);
    }
  }
}
