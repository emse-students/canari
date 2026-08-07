/**
 * Saving a decrypted attachment to the user's own storage.
 *
 * A WebView is not a browser. `<a download>` - which is the whole of the web download path -
 * is handled by the *shell*, not by the page: Chrome and Safari own a download manager,
 * Android's WebView hands the request to a `DownloadListener` and drops it when none is set,
 * and WKWebView needs a `WKDownloadDelegate`. Tauri installs neither, so on Android and iOS
 * the anchor click succeeds, dispatches, and produces nothing at all - no file, no error, no
 * console line. That is the whole of "the download button does nothing on mobile".
 *
 * On Tauri the bytes are therefore read back out of the object URL and written through the
 * native save dialog: `ACTION_CREATE_DOCUMENT` (SAF) on Android, a document picker on iOS,
 * the OS save panel on desktop. The picked destination is added to the `fs` scope by the
 * dialog plugin itself, so no broad filesystem grant is needed - but `fs:allow-write-file`
 * and `dialog:allow-save` must both be in `capabilities/default.json`, or this rejects on the
 * device with `fs.write_file not allowed` while building and shipping perfectly.
 */

import { isTauriRuntime } from './openExternal';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';

/** The web path: hand the object URL to the browser's own download machinery. */
function anchorDownload(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.click();
}

/** The Tauri path: pick a destination, write the bytes there. */
async function writeThroughSaveDialog(bytes: Uint8Array, fileName: string): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const target = await save({ defaultPath: fileName });
  if (!target) {
    console.debug('[download] save dialog cancelled');
    return false;
  }

  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(target, bytes);
  console.debug(`[download] wrote ${bytes.byteLength} bytes to ${target}`);
  return true;
}

/**
 * Writes an already-decrypted object URL to a file chosen by the user.
 *
 * @param url - Object URL of the decrypted bytes.
 * @param fileName - Suggested file name.
 * @returns `true` once written, `false` when the user cancelled the save dialog.
 * @throws When reading the blob or writing the file fails; callers report it.
 */
export async function saveObjectUrlAs(url: string, fileName: string): Promise<boolean> {
  console.debug(`[download] saving "${fileName}" (tauri=${isTauriRuntime()})`);

  if (!isTauriRuntime()) {
    anchorDownload(url, fileName);
    return true;
  }

  // Read the bytes BEFORE the dialog: the object URL belongs to the caller and the dialog
  // hands control to another activity, which is exactly when a component may unmount.
  const response = await fetch(url);
  return writeThroughSaveDialog(new Uint8Array(await response.arrayBuffer()), fileName);
}

/**
 * {@link saveObjectUrlAs} for a caller that already holds the bytes. It owns the object URL's
 * whole lifetime, so nothing leaks when the download is one of the many that are generated on
 * the spot (an .ics, an .xlsx export, a decrypted vault document).
 */
export async function saveBlobAs(blob: Blob, fileName: string): Promise<boolean> {
  console.debug(`[download] saving "${fileName}" (tauri=${isTauriRuntime()})`);

  if (!isTauriRuntime()) {
    const url = URL.createObjectURL(blob);
    try {
      anchorDownload(url, fileName);
    } finally {
      // Not immediately: revoking in the same task can beat the browser's own read of the
      // URL the click just queued.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return true;
  }

  return writeThroughSaveDialog(new Uint8Array(await blob.arrayBuffer()), fileName);
}

/**
 * The reporting wrapper every UI download goes through: a confirmation toast on Tauri (where
 * nothing else signals success - there is no download shelf) and an error toast on failure. A
 * silent failure here is the bug this module exists to remove, so nothing is swallowed
 * without a log.
 *
 * @param source - Either an object URL the caller owns, or the bytes themselves.
 */
export async function downloadDecryptedFile(
  source: string | Blob,
  fileName: string
): Promise<void> {
  try {
    const saved =
      typeof source === 'string'
        ? await saveObjectUrlAs(source, fileName)
        : await saveBlobAs(source, fileName);
    if (saved && isTauriRuntime()) showToast(m.common_download_saved(), 'info');
  } catch (err) {
    console.error('[download] failed', err);
    showToast(m.common_download_failed(), 'error');
  }
}
