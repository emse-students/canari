/**
 * Reads the share the native layer left for the page (`pending_share.json`) into `incomingShare`,
 * and later reads its files when it is staged.
 *
 * Android's `IncomingShare.kt` copies whatever another app shared into the app cache and writes a
 * manifest; `read_and_clear_pending_share` hands that manifest over exactly once. THE COPIES STAY ON
 * DISK until the member has picked a destination and that conversation is displayed: the drain runs
 * at mount, before the PIN, and reading a share's files there would hold them in the WebView for as
 * long as the member takes to unlock and choose. Only `readSharedFiles` reads them, each through
 * `take_picked_file`, which also deletes the copy. See `docs/wiki/frontend/sharing.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { Log } from '$lib/utils/Log';
import { incomingShare, type SharedFileEntry } from '$lib/stores/incomingShare.svelte';

/** The native manifest, validated. */
export interface SharedManifest {
  text: string;
  files: SharedFileEntry[];
  /** Streams the native side did not keep (unreadable, too large, past a cap, not the sender's). */
  refused: number;
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
          typeof (f as SharedFileEntry).mime === 'string'
      )
    : [];
  return {
    text: typeof record.text === 'string' ? record.text : '',
    files,
    refused: typeof record.refused === 'number' && record.refused > 0 ? record.refused : 0,
  };
}

/**
 * Drains a waiting share, if any, into `incomingShare` - its text and the NAMES of its files, no
 * bytes. Returns how many shared items were already lost natively, so the caller can say so; null
 * when nothing was waiting.
 */
export async function drainNativeShare(): Promise<{ lost: number } | null> {
  let raw: string | null;
  try {
    raw = await invoke<string | null>('read_and_clear_pending_share');
  } catch (error) {
    console.error(`[SHARE] the native share could not be drained: ${String(error)}`);
    return null;
  }
  if (!raw) return null;
  const manifest = parseSharedManifest(raw);
  if (!manifest) {
    console.error('[SHARE] the native share manifest is unreadable - dropped');
    return { lost: 1 };
  }
  Log.d(
    'IncomingShare',
    `drained: ${manifest.text.length} chars, ${manifest.files.length} file(s), ${manifest.refused} refused natively`
  );
  incomingShare.offer({ text: manifest.text, files: manifest.files });
  return { lost: manifest.refused };
}

/**
 * Reads a staged share's files into `File`s, each copy deleted as it is read. A copy that cannot be
 * read (a newer share swept it, the OS purged the cache) is counted in `lost`, never thrown.
 */
export async function readSharedFiles(
  entries: SharedFileEntry[]
): Promise<{ files: File[]; lost: number }> {
  const files: File[] = [];
  let lost = 0;
  for (const entry of entries) {
    try {
      const bytes = await invoke<ArrayBuffer>('take_picked_file', { path: entry.path });
      files.push(new File([bytes], entry.name, { type: entry.mime, lastModified: Date.now() }));
    } catch (error) {
      lost++;
      console.error(`[SHARE] a shared file could not be read: ${String(error)}`);
    }
  }
  Log.d('IncomingShare', `read ${files.length} file(s), ${lost} lost`);
  return { files, lost };
}
