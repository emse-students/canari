import { invoke } from '@tauri-apps/api/core';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';
import { showToast } from '$lib/stores/toast.svelte';

/**
 * THE iOS APP'S PHOTO LIBRARY AND DOCUMENT PICKER, OPENED NATIVELY - so the composer's menu is the
 * only menu (see `attachSources.ts` for why a file input cannot do it on iOS).
 *
 * `tauri-plugin-dialog`'s `open` presents `PHPickerViewController` for `pickerMode: 'media'` and
 * `UIDocumentPickerViewController` (as a copy) otherwise, and returns where it COPIED each pick.
 * `take_picked_file` (Rust, `commands/picked_files.rs`) reads a copy and deletes it; the bytes become a
 * `File` named as the picker named it, typed from its extension - the picker hands no MIME type, and
 * the rest of the pipeline reads `file.type` exactly as it does for an input's files.
 */

/** Extension -> MIME for what the two pickers hand back. An unknown one stays `''`, as a browser leaves it. */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip',
  txt: 'text/plain',
};

/** The last path segment of a picked path or `file://` URL, percent-decoded. */
export function pickedFileName(path: string): string {
  const last = path.split(/[\\/]/).pop() ?? path;
  try {
    return decodeURIComponent(last);
  } catch {
    console.warn(`[NativeAttachPicker] a picked name is not percent-encoded text, kept as is`);
    return last;
  }
}

/** The MIME type of a picked file, from its extension. */
export function mimeForPickedName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? '';
}

/**
 * Opens the native picker and resolves with what was picked - `[]` when the reader cancelled. A pick
 * whose bytes cannot be read is logged at error level, left out and COUNTED in a notice; the others
 * still arrive.
 *
 * EVERY PICK IS READ WHOLE INTO MEMORY before any caller can check it: the picker hands back paths
 * only - no size, no duration - so a ceiling (a reel's 90 s) is applied AFTER the read. `single`
 * lets a caller that keeps one file (the CanaReels gallery) make the picker offer one, so nothing it
 * would throw away is ever read.
 */
export async function pickNatively(
  kind: 'library' | 'files',
  options: { single?: boolean } = {}
): Promise<File[]> {
  const multiple = !options.single;
  Log.d('NativeAttachPicker', `open ${kind}${multiple ? '' : ' (one file)'}`);
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked =
    kind === 'library'
      ? await open({ multiple, pickerMode: 'media' })
      : await open({ multiple, fileAccessMode: 'copy' });
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  Log.d('NativeAttachPicker', `${kind}: ${paths.length} picked`);
  const files: File[] = [];
  let unread = 0;
  for (const path of paths) {
    try {
      const bytes = await invoke<ArrayBuffer>('take_picked_file', { path });
      const name = pickedFileName(path);
      files.push(
        new File([bytes], name, { type: mimeForPickedName(name), lastModified: Date.now() })
      );
    } catch (error) {
      unread += 1;
      console.error(`[NativeAttachPicker] a picked file could not be read: ${String(error)}`);
    }
  }
  // THE ESSENTIAL IS NEVER LOST SILENTLY (principle 2): 8 of 11 picks vanished and the screen only
  // showed a count. Whatever could not be read is said, with how many.
  if (unread > 0) {
    showToast(m.composer_native_pick_unread({ count: unread, total: paths.length }), 'warning');
  }
  return files;
}
