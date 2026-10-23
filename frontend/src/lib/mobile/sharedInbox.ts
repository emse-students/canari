/**
 * Deletes the on-disk copies of a share INTO Canari that will never be staged.
 *
 * While the app runs, a copy is deleted by whoever ends its share: `take_picked_file` as the chat
 * page reads it, or this, when the page drops it unread - the member dismissed the picker, a newer
 * share replaced it, or it is over the upload ceiling. Without it, a dropped share's copies (up to
 * 300 MB) would sit in the cache until the next process start sweeps them. It also parses the
 * native manifest (`parseSharedManifest`), which the sign-out erase reads too. Kept apart from
 * `incomingShareDrain` - which reaches `media.ts`, and through it `stores/auth` - so the store and
 * the sign-out path can call it without an import cycle.
 * See `docs/wiki/frontend/sharing.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { Log } from '$lib/utils/Log';
import type { SharedFileEntry } from '$lib/stores/incomingShare.svelte';
import { conversationIdFromShareTarget } from '$lib/sharing/shareTargetsNative';

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

/** The native manifest, validated. */
export interface SharedManifest {
  text: string;
  files: SharedFileEntry[];
  /** Streams the native side did not keep (unreadable, too large, past a cap, not the sender's). */
  refused: number;
  /**
   * The share epoch when the capture STARTED (`IncomingShare.kt`); 0 when absent. A manifest older
   * than the current epoch was made in a session that has since signed out.
   */
  epoch: number;
  /**
   * The conversation the member picked among the share sheet's suggestions (sharing lot S5), from
   * the shortcut id `IncomingShare.kt` carried; null when none, or not of the suggestion shape. A
   * HINT only: the picker preselects it only if the signed-in account holds that conversation.
   */
  target: string | null;
}

/**
 * Parses the manifest, keeping only well-formed file entries. Null when the JSON is unreadable or
 * not an object - a corrupt handoff is dropped, never half-offered.
 */
export function parseSharedManifest(raw: string): SharedManifest | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const files = Array.isArray(record.files)
    ? record.files.filter(
        (f): f is SharedFileEntry =>
          typeof f === 'object' &&
          f !== null &&
          typeof (f as SharedFileEntry).path === 'string' &&
          typeof (f as SharedFileEntry).name === 'string' &&
          typeof (f as SharedFileEntry).mime === 'string' &&
          typeof (f as SharedFileEntry).size === 'number' &&
          (f as SharedFileEntry).size >= 0
      )
    : [];
  return {
    text: typeof record.text === 'string' ? record.text : '',
    files,
    refused: typeof record.refused === 'number' && record.refused > 0 ? record.refused : 0,
    epoch: typeof record.epoch === 'number' && record.epoch > 0 ? record.epoch : 0,
    target: conversationIdFromShareTarget(record.target),
  };
}
