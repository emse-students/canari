/**
 * Reads the share the native layer left for the page (`pending_share.json`) into `incomingShare`.
 *
 * Android's `IncomingShare.kt` copies whatever another app shared into the app cache and writes a
 * manifest; `read_and_clear_pending_share` hands that manifest over exactly once, and each copy is
 * then read AND deleted by `take_picked_file`, the same allowlisted command the system pickers use.
 * See `docs/wiki/frontend/sharing.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { Log } from '$lib/utils/Log';
import { incomingShare } from '$lib/stores/incomingShare.svelte';

/** One copied file, as the native manifest names it. */
export interface SharedFileEntry {
  path: string;
  name: string;
  mime: string;
}

/** The native manifest, validated. */
export interface SharedManifest {
  text: string;
  files: SharedFileEntry[];
  /** Streams the native side could not keep (unreadable, too large, past the count cap). */
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
 * Drains a waiting share, if any, into `incomingShare`. Returns how many shared items were lost on
 * the way (refused natively, or a copy that could not be read), so the caller can say so.
 * Returns null when nothing was waiting.
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
  const files: File[] = [];
  let lost = manifest.refused;
  for (const entry of manifest.files) {
    try {
      const bytes = await invoke<ArrayBuffer>('take_picked_file', { path: entry.path });
      files.push(new File([bytes], entry.name, { type: entry.mime, lastModified: Date.now() }));
    } catch (error) {
      lost++;
      console.error(`[SHARE] a shared file could not be read: ${String(error)}`);
    }
  }
  incomingShare.offer({ text: manifest.text, files });
  return { lost };
}
