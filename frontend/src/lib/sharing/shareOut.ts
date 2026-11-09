/**
 * SHARING OUT OF CANARI: the system share sheet on a message's text, a decrypted attachment, or a
 * post's public link - "Partager..." the way Messenger or Discord offer it (lot S3).
 *
 * Phone apps only (`canShareOut`): the sheet is native, through `tauri-plugin-gallery`
 * (`share_text`, `share_staged`). A FILE is decrypted here, staged into the app cache in base64
 * chunks exactly as a reel is for the gallery (`stageBlob`, same reason: Android IPC is JSON), then
 * moved into the cache's `share_out/` - the one directory the app's FileProvider exposes - and the
 * sheet is opened on it. That copy is the only plaintext that leaves the WebView, and it stays until
 * the next share, the next sign-out or the next launch, because the receiving app reads it on its
 * own schedule.
 * See `docs/wiki/frontend/share-out.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import type { MediaRef } from '$lib/media';
import { galleryCommand } from '$lib/services/galleryCommands';
import { GalleryError, hasNativeGallery, stageBlob } from '$lib/reels/gallery';
import {
  acquireDecryptedMediaBlobUrl,
  releaseDecryptedMediaBlobUrl,
} from '$lib/utils/mediaBlobCache';
import { mediaUrl } from '$lib/utils/apiUrl';
import { m } from '$lib/paraglide/messages';
import { showToast } from '$lib/stores/toast.svelte';
import { Log } from '$lib/utils/Log';

/** Whether this build has a system share sheet to open: the phone apps. */
export function canShareOut(): boolean {
  return hasNativeGallery();
}

/**
 * THE ONE PLACE A SHARE-SHEET FAILURE IS TOLD TO THE MEMBER. Runs `open` (any of the `*Out`
 * functions below) and, when the sheet did not open, logs it and shows the "could not open" toast -
 * a tap on "Share" that silently does nothing reads as a dead button. There is no fallback to a
 * copy: the sheet's rows are only drawn where one exists (`canShareOut`).
 *
 * @param what - What is being shared, for the log line only.
 * @returns `true` once the sheet opened, `false` after the failure toast.
 */
export async function runShareOut(what: string, open: () => Promise<void>): Promise<boolean> {
  Log.d('shareOut', `opening the share sheet on ${what}`);
  try {
    await open();
    return true;
  } catch (e) {
    Log.d('shareOut', `the share sheet did not open on ${what}: ${String(e)}`);
    showToast(m.share_out_failed(), 'error');
    return false;
  }
}

/** Opens the share sheet on a text (a message, a link). @throws {GalleryError} */
export async function shareTextOut(text: string): Promise<void> {
  if (!canShareOut()) throw new GalleryError('unavailable', 'share: not a phone build');
  console.debug(`[share-out] text, ${text.length} chars`);
  try {
    await invoke(galleryCommand('shareText'), { text });
  } catch (err) {
    console.error('[share-out] the sheet did not open on the text', err);
    throw new GalleryError('failed', 'share: the sheet did not open', { cause: err });
  }
}

/**
 * The name a shared attachment carries: its own name reduced to a last segment of safe characters,
 * or one made of its id and type. The receiving app shows it, and Rust refuses anything that names
 * a path, so nothing here may contain a separator or `..`.
 */
export function sharedFileName(ref: Pick<MediaRef, 'fileName' | 'mediaId' | 'mimeType'>): string {
  const own = (ref.fileName ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 100);
  if (own) return own;
  const subtype = ref.mimeType.split('/')[1]?.split(/[;+]/)[0] ?? '';
  const ext = /^[a-z0-9]{1,8}$/.test(subtype) ? `.${subtype === 'jpeg' ? 'jpg' : subtype}` : '';
  return `canari-${ref.mediaId.slice(0, 8)}${ext}`;
}

/** The mime type the receiving app is told: the ref's own when it is a plain `type/subtype`. */
function plainMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) ? base : 'application/octet-stream';
}

/** Opens the share sheet on a blob, under `name`. @throws {GalleryError} */
export async function shareBlobOut(blob: Blob, name: string, mime: string): Promise<void> {
  if (!canShareOut()) throw new GalleryError('unavailable', 'share: not a phone build');
  const session = crypto.randomUUID();
  // Not the name: it is the member's attachment name.
  console.debug(`[share-out] a file, ${blob.size} bytes, ${mime}, session ${session}`);
  try {
    await stageBlob(session, blob);
    // `share_staged` moves or removes the staged copy on every path it reaches.
    await invoke(galleryCommand('shareStaged'), { session, name, mime: plainMime(mime) });
  } catch (err) {
    console.error('[share-out] the sheet did not open on the file', err);
    await invoke(galleryCommand('discardVideo'), { session }).catch((discardErr: unknown) => {
      console.error('[share-out] the staged copy was not discarded', discardErr);
    });
    throw new GalleryError('failed', 'share: the sheet did not open', { cause: err });
  }
}

export interface ShareMediaDeps {
  acquire: (ref: MediaRef, baseUrl: string) => Promise<string>;
  release: (ref: MediaRef) => void;
  readBlob: (url: string) => Promise<Blob>;
  shareBlob: (blob: Blob, name: string, mime: string) => Promise<void>;
}

const defaultDeps: ShareMediaDeps = {
  acquire: (ref, baseUrl) => acquireDecryptedMediaBlobUrl(ref, baseUrl),
  release: releaseDecryptedMediaBlobUrl,
  readBlob: async (url) => (await fetch(url)).blob(),
  shareBlob: shareBlobOut,
};

/**
 * Opens the share sheet on a message's attachment, decrypted from the app's media cache the way
 * the bubble draws it. @throws {GalleryError} when the sheet cannot open, or what the decryption
 * throws.
 */
export async function shareMediaOut(
  ref: MediaRef,
  deps: ShareMediaDeps = defaultDeps
): Promise<void> {
  const url = await deps.acquire(ref, mediaUrl());
  try {
    const blob = await deps.readBlob(url);
    await deps.shareBlob(blob, sharedFileName(ref), ref.mimeType);
  } finally {
    deps.release(ref);
  }
}
