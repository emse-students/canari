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
 *
 * On Android the destination is a `content://` document, and it is NOT written through
 * `plugin-fs`: that write left the Downloads provider recording a size of 0 (see
 * {@link isProviderDocument}). It goes through the provider's own stream instead.
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

/**
 * The extension of a file name, without its dot, or `null` when it has none: `a.mp3` -> `mp3`,
 * `a.tar.gz` -> `gz`, and `Makefile`, `.bashrc` (a dotfile) and `name.` (trailing dot) -> `null`.
 */
export function fileExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1);
}

/**
 * The save dialog's filters for a file name. WHY: Android's `ACTION_CREATE_DOCUMENT` carries a
 * MIME type, and the documents provider only treats the name's extension as an extension when
 * that MIME type matches it. With no filter the dialog asks for the wildcard type, the provider
 * reads `X.mp3` as a bare name, and the second save of it becomes `X.mp3 (1)` - extension lost -
 * instead of `X (1).mp3`. The extension as a filter makes the plugin send the matching type.
 */
export function saveDialogFilters(fileName: string): { name: string; extensions: string[] }[] {
  const extension = fileExtension(fileName);
  return extension ? [{ name: extension, extensions: [extension] }] : [];
}

/**
 * Whether the save dialog's answer is a document owned by a provider (`content://`, Android's
 * `ACTION_CREATE_DOCUMENT`) rather than a path. The URI itself carries the fact: only a provider's
 * own stream may write it (see {@link writeIntoDocument}).
 */
export function isProviderDocument(target: string): boolean {
  return target.startsWith('content://');
}

/**
 * Writes into an Android document through the provider's own stream, opened and closed natively.
 *
 * WHY NOT `writeFile`: `plugin-fs` detaches the descriptor from its `ParcelFileDescriptor`, which
 * tells the provider "closed" before a byte is written. The Downloads provider records the size
 * then - 0 - and keeps it, so the file lists as "0 octet(s)" and an app it is shared to from there
 * (Messenger) refuses it or reads 0 bytes, while the disk holds every byte (Mi 9T, 2026-11-04).
 * The bytes are staged into the app cache exactly as a reel or a shared file is (Android IPC is
 * JSON), then copied by `write_staged_document`, which removes the staged copy on every path.
 */
async function writeIntoDocument(bytes: Uint8Array, target: string): Promise<void> {
  const [{ invoke }, { stageBlob }, { galleryCommand }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('$lib/reels/gallery'),
    import('$lib/services/galleryCommands'),
  ]);
  const session = crypto.randomUUID();
  /** Removes the staged copy after a failure, so it does not wait for the next launch. */
  const discardStaged = () =>
    invoke(galleryCommand('discardVideo'), { session }).catch((discardErr: unknown) => {
      console.error('[download] the staged copy was not discarded', discardErr);
    });
  console.debug(`[download] staging ${bytes.byteLength} bytes for a provider document, ${session}`);
  try {
    await stageBlob(session, new Blob([bytes as BlobPart]));
  } catch (err) {
    console.error('[download] staging for the provider document failed', err);
    await discardStaged();
    throw err;
  }
  let written: number;
  try {
    ({ written } = await invoke<{ written: number }>(galleryCommand('writeStagedDocument'), {
      session,
      uri: target,
    }));
  } catch (err) {
    // The command removes the staged copy on every path it runs; a rejection before it ran
    // (IPC, permission) would leave the copy behind, so discard it here - a no-op otherwise.
    console.error('[download] writing the provider document failed', err);
    await discardStaged();
    throw err;
  }
  console.debug(`[download] the provider's stream took ${written} bytes and closed`);
}

/** The Tauri path: pick a destination, write the bytes there. */
async function writeThroughSaveDialog(bytes: Uint8Array, fileName: string): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const filters = saveDialogFilters(fileName);
  console.debug(`[download] save dialog for "${fileName}", filters=${JSON.stringify(filters)}`);
  const target = await save({ defaultPath: fileName, filters });
  if (!target) {
    console.debug('[download] save dialog cancelled');
    return false;
  }

  if (isProviderDocument(target)) {
    await writeIntoDocument(bytes, target);
    return true;
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
