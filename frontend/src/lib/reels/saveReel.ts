/**
 * SAVING ONE OF THE MEMBER'S REELS BEFORE THE SERVER DELETES IT (C6).
 *
 * The video is read out of the app's media cache (decrypted with the key `my-reels` handed over),
 * then given to the phone's gallery (`tauri-plugin-gallery`) or, on the web and the desktop app,
 * to the browser's download / the save dialog (`saveBlobAs`). It is the fragmented H.264/AAC MP4
 * every reel was prepared into (C3), which both Photos and Android's gallery play.
 */
import type { MediaRef } from '$lib/media';
import type { MyReel } from '$lib/posts/api';
import {
  acquireDecryptedMediaBlobUrl,
  releaseDecryptedMediaBlobUrl,
} from '$lib/utils/mediaBlobCache';
import { mediaUrl } from '$lib/utils/apiUrl';
import { saveBlobAs } from '$lib/utils/fileDownload';
import { GalleryError, hasNativeGallery, saveVideoToGallery } from './gallery';

/** What a save came to: in the gallery, refused gallery access, downloaded, or a dialog cancelled. */
export type ReelSaveOutcome = 'saved' | 'denied' | 'downloaded' | 'cancelled';

export interface SaveReelDeps {
  acquire: (ref: MediaRef, baseUrl: string) => Promise<string>;
  release: (ref: MediaRef) => void;
  readBlob: (url: string) => Promise<Blob>;
  hasNativeGallery: () => boolean;
  saveToGallery: (bytes: Uint8Array, name: string) => Promise<'saved' | 'denied'>;
  saveBlobAs: (blob: Blob, name: string) => Promise<boolean>;
}

const defaultDeps: SaveReelDeps = {
  acquire: (ref, baseUrl) => acquireDecryptedMediaBlobUrl(ref, baseUrl),
  release: releaseDecryptedMediaBlobUrl,
  readBlob: async (url) => (await fetch(url)).blob(),
  hasNativeGallery,
  saveToGallery: saveVideoToGallery,
  saveBlobAs,
};

/** The file name a saved reel gets: its day and a short id, so two reels of one day differ. */
export function reelFileName(reel: Pick<MyReel, 'id' | 'createdAt'>): string {
  const day = reel.createdAt.slice(0, 10);
  return `canari-reel-${day}-${reel.id.slice(0, 8)}.mp4`;
}

/** Saves one of the member's reels. @throws {GalleryError} when the video cannot be saved. */
export async function saveReel(
  reel: MyReel,
  deps: SaveReelDeps = defaultDeps
): Promise<ReelSaveOutcome> {
  const ref = reel.media[0];
  if (!ref) throw new GalleryError('failed', `reel ${reel.id} carries no video`);
  const name = reelFileName(reel);
  console.debug(`[reel-save] ${reel.id} as ${name}`);
  const url = await deps.acquire(ref, mediaUrl());
  try {
    const blob = await deps.readBlob(url);
    if (deps.hasNativeGallery()) {
      return await deps.saveToGallery(new Uint8Array(await blob.arrayBuffer()), name);
    }
    return (await deps.saveBlobAs(blob, name)) ? 'downloaded' : 'cancelled';
  } finally {
    deps.release(ref);
  }
}
