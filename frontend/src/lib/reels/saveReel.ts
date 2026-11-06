/**
 * SAVING ONE OF THE MEMBER'S REELS BEFORE THE SERVER DELETES IT (C6).
 *
 * The video is read out of the app's media cache (decrypted with the key `my-reels` handed over),
 * then given to the phone's gallery (`tauri-plugin-gallery`) or, on the web and the desktop app,
 * to the browser's download / the save dialog (`saveBlobAs`). A reel is the fragmented H.264/AAC MP4
 * every reel was prepared into (C3), which both Photos and Android's gallery play. A FEED VIDEO
 * shown in the viewer (owner, 2026-11-06) keeps the type it was uploaded with - mp4, mov, webm -
 * and is saved under that extension and mime, never relabelled an MP4.
 */
import type { MediaRef } from '$lib/media';
import type { PostMediaRef } from '$lib/posts/api';
import {
  acquireDecryptedMediaBlobUrl,
  releaseDecryptedMediaBlobUrl,
} from '$lib/utils/mediaBlobCache';
import { mediaUrl } from '$lib/utils/apiUrl';
import { saveBlobAs } from '$lib/utils/fileDownload';
import { isIosTauriRuntime } from '$lib/utils/appVersion';
import { GalleryError, hasNativeGallery, saveVideoToGallery } from './gallery';

/** What a save came to: in the gallery, refused gallery access, downloaded, or a dialog cancelled. */
export type ReelSaveOutcome = 'saved' | 'denied' | 'downloaded' | 'cancelled';

export interface SaveReelDeps {
  acquire: (ref: MediaRef, baseUrl: string) => Promise<string>;
  release: (ref: MediaRef) => void;
  readBlob: (url: string) => Promise<Blob>;
  hasNativeGallery: () => boolean;
  saveToGallery: (video: Blob, name: string, mime: string) => Promise<'saved' | 'denied'>;
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

/** The container of a saved video: its file extension and the mime the platform is told. */
export interface SavedVideoType {
  ext: string;
  mime: string;
}

const MP4: SavedVideoType = { ext: 'mp4', mime: 'video/mp4' };

/**
 * The container a stored video was uploaded in, read from its `mimeType`: a mov stays a mov and a
 * webm a webm. Anything unnamed (or not a video) is an MP4, what every reel is.
 */
export function savedVideoType(mimeType: string | undefined): SavedVideoType {
  switch ((mimeType ?? '').split(';')[0].trim().toLowerCase()) {
    case 'video/quicktime':
      return { ext: 'mov', mime: 'video/quicktime' };
    case 'video/webm':
      return { ext: 'webm', mime: 'video/webm' };
    case 'video/x-m4v':
      return { ext: 'm4v', mime: 'video/x-m4v' };
    case 'video/3gpp':
      return { ext: '3gp', mime: 'video/3gpp' };
    default:
      return MP4;
  }
}

/**
 * Whether the platform's gallery can take this video. Photos on iOS reads no WebM; everything else
 * (Android's gallery, the browser's download) takes what it is given. The rail hides the save for a
 * video this says no to, rather than offering a save that fails.
 */
export function canSaveVideo(
  reel: Pick<SaveableReel, 'media'>,
  iosApp: boolean = isIosTauriRuntime()
): boolean {
  return !(iosApp && savedVideoType(reel.media[0]?.mimeType).ext === 'webm');
}

/**
 * The file name a saved video gets: its day and a short id, so two of one day differ. A reel is
 * `canari-reel-...`; a feed post of one video (`kind: 'post'`) is not a reel and is not called one.
 */
export function reelFileName(
  reel: Pick<SaveableReel, 'id' | 'createdAt' | 'kind' | 'media'>
): string {
  const day = reel.createdAt.slice(0, 10);
  const what = reel.kind === 'post' ? 'video' : 'reel';
  return `canari-${what}-${day}-${reel.id.slice(0, 8)}.${savedVideoType(reel.media[0]?.mimeType).ext}`;
}

/**
 * What a save needs of a reel: an id and a day for the file name, and `media[0]` with its key. A
 * feed reel, one of the member's own and a reel received in a conversation all have them.
 */
export interface SaveableReel {
  id: string;
  /** ISO date; its day names the saved file. */
  createdAt: string;
  /** `media[0]` is the video, with its key. */
  media: PostMediaRef[];
  /** `'post'` for a feed video shown in the viewer; absent (a reel in a conversation) or `'reel'` is a reel. */
  kind?: string;
}

/** Saves a reel - ANY reel the member can watch, public or not. @throws {GalleryError} when it cannot be saved. */
export async function saveReel(
  reel: SaveableReel,
  deps: SaveReelDeps = defaultDeps
): Promise<ReelSaveOutcome> {
  const ref = reel.media[0];
  if (!ref) throw new GalleryError('failed', `reel ${reel.id} carries no video`);
  const name = reelFileName(reel);
  const { mime } = savedVideoType(ref.mimeType);
  console.debug(`[reel-save] ${reel.id} as ${name} (${mime})`);
  const url = await deps.acquire(ref, mediaUrl());
  try {
    const blob = await deps.readBlob(url);
    if (deps.hasNativeGallery()) {
      return await deps.saveToGallery(blob, name, mime);
    }
    return (await deps.saveBlobAs(blob, name)) ? 'downloaded' : 'cancelled';
  } finally {
    deps.release(ref);
  }
}
