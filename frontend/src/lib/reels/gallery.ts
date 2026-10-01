/**
 * THE PHONE'S GALLERY AND ITS SETTINGS PAGE, from the WebView (`tauri-plugin-gallery`, C6).
 *
 * `saveVideoToGallery` hands the decrypted video to the platform as the RAW IPC body - tens of
 * megabytes that a JSON argument would inflate and copy - with its name in a header. The answer is
 * an OUTCOME: `saved`, or `denied` when the member refused the gallery access iOS (or Android 9)
 * asks for; a failure to save is a thrown `GalleryError`.
 *
 * `openAppSettings` opens this app's page in the system settings: the remedy a "denied" camera,
 * microphone or gallery names, so the screen that names it can offer it.
 */
import { invoke } from '@tauri-apps/api/core';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';
import { GALLERY_NAME_HEADER, galleryCommand } from '$lib/services/galleryCommands';

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

/** Whether this build has a gallery to save into and a settings page to open: the phone apps. */
export function hasNativeGallery(): boolean {
  return isMobileTauriRuntime();
}

/** Saves an MP4 into the phone's gallery (Android `Movies/Canari`, iOS Photos). */
export async function saveVideoToGallery(
  bytes: Uint8Array,
  name: string
): Promise<GallerySaveOutcome> {
  if (!hasNativeGallery()) throw new GalleryError('unavailable', 'gallery: not a phone build');
  console.debug(`[gallery] saving ${name}, ${bytes.byteLength} bytes`);
  let answer: { status: string };
  try {
    answer = await invoke<{ status: string }>(galleryCommand('saveVideo'), bytes, {
      headers: { [GALLERY_NAME_HEADER]: name },
    });
  } catch (err) {
    console.error('[gallery] the save failed', err);
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
