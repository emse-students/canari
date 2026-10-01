/**
 * THE PHONE'S GALLERY AND ITS SETTINGS PAGE, from the WebView (`tauri-plugin-gallery`, C6).
 *
 * `saveVideoToGallery` STAGES the decrypted video into the app cache in base64 chunks, then asks
 * the platform to import that file. Chunks because on Android every IPC call is JSON through
 * `postMessage` - Tauri never uses its custom-protocol transport there, the WebView cannot read a
 * request body - so a `Uint8Array` would cross as a JSON array of numbers, several times the video
 * in one string. Measured on the Mi 9T (2026-10-02): a raw body reached Rust as JSON. Each chunk
 * carries its offset, and Rust refuses one that does not start where the file ends.
 *
 * The answer is an OUTCOME: `saved`, or `denied` when the member refused the gallery access iOS (or
 * Android 9) asks for; a failure to save is a thrown `GalleryError`, and the staged file is
 * discarded on that path.
 *
 * `openAppSettings` opens this app's page in the system settings: the remedy a "denied" camera,
 * microphone or gallery names, so the screen that names it can offer it.
 */
import { invoke } from '@tauri-apps/api/core';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { galleryCommand } from '$lib/services/galleryCommands';

export type GallerySaveOutcome = 'saved' | 'denied';

/** Why the platform could not do it: not a phone build, or the save itself failed. */
export type GalleryFault = 'unavailable' | 'failed';

export class GalleryError extends Error {
  constructor(
    readonly fault: GalleryFault,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'GalleryError';
  }
}

/**
 * Bytes per staged chunk: a multiple of 3, so no chunk but the last carries base64 padding, and
 * small enough that one IPC message stays around a megabyte of text.
 */
export const GALLERY_CHUNK_BYTES = 3 * 256 * 1024;

/** Whether this build has a gallery to save into and a settings page to open: the phone apps. */
export function hasNativeGallery(): boolean {
  return isMobileTauriRuntime();
}

/** One slice of a blob as base64, read by the engine (`readAsDataURL`) rather than a JS loop. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/** Stages the video chunk by chunk under `session`. */
async function stage(session: string, video: Blob): Promise<void> {
  for (let offset = 0; offset < video.size; offset += GALLERY_CHUNK_BYTES) {
    const data = await blobToBase64(video.slice(offset, offset + GALLERY_CHUNK_BYTES));
    await invoke<number>(galleryCommand('appendVideoChunk'), { session, offset, data });
  }
}

/** Saves an MP4 into the phone's gallery (Android `Movies/Canari`, iOS Photos). */
export async function saveVideoToGallery(video: Blob, name: string): Promise<GallerySaveOutcome> {
  if (!hasNativeGallery()) throw new GalleryError('unavailable', 'gallery: not a phone build');
  const session = crypto.randomUUID();
  console.debug(`[gallery] saving ${name}, ${video.size} bytes, session ${session}`);
  let answer: { status: string };
  try {
    await stage(session, video);
    answer = await invoke<{ status: string }>(galleryCommand('saveVideo'), { session, name });
  } catch (err) {
    console.error('[gallery] the save failed', err);
    // `save_video` removes its file on every path; a failure BEFORE it leaves a staged one behind.
    await invoke(galleryCommand('discardVideo'), { session }).catch((discardErr: unknown) => {
      console.error('[gallery] the staged copy was not discarded', discardErr);
    });
    throw new GalleryError('failed', 'gallery: the save failed', { cause: err });
  }
  if (answer.status === 'saved' || answer.status === 'denied') {
    console.debug(`[gallery] ${answer.status}`);
    return answer.status;
  }
  console.error(`[gallery] the platform answered an unknown status: ${answer.status}`);
  throw new GalleryError('failed', `gallery: unknown status ${answer.status}`);
}

/** Opens this app's page in the system settings. */
export async function openAppSettings(): Promise<void> {
  if (!hasNativeGallery()) throw new GalleryError('unavailable', 'settings: not a phone build');
  console.debug('[gallery] opening the app settings');
  try {
    await invoke(galleryCommand('openAppSettings'));
  } catch (err) {
    console.error('[gallery] the settings page did not open', err);
    throw new GalleryError('failed', 'settings: did not open', { cause: err });
  }
}
