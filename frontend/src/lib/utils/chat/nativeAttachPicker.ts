import { invoke } from '@tauri-apps/api/core';
import { Log } from '$lib/utils/Log';

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
 * whose bytes cannot be read is logged at error level and left out; the others still arrive.
 */
export async function pickNatively(kind: 'library' | 'files'): Promise<File[]> {
  Log.d('NativeAttachPicker', `open ${kind}`);
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked =
    kind === 'library'
      ? await open({ multiple: true, pickerMode: 'media' })
      : await open({ multiple: true, fileAccessMode: 'copy' });
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  Log.d('NativeAttachPicker', `${kind}: ${paths.length} picked`);
  const files: File[] = [];
  for (const path of paths) {
    try {
      const bytes = await invoke<ArrayBuffer>('take_picked_file', { path });
      const name = pickedFileName(path);
      files.push(
        new File([bytes], name, { type: mimeForPickedName(name), lastModified: Date.now() })
      );
    } catch (error) {
      console.error(`[NativeAttachPicker] a picked file could not be read: ${String(error)}`);
    }
  }
  return files;
}
