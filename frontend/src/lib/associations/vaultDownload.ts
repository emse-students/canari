/**
 * The one fetch of an association vault document's ciphertext, shared by the vault and the
 * reviewer page.
 *
 * WHY THE 410 IS CLASSIFIED HERE, AT THE THROW: both pages used to throw
 * `new Error('Download failed: <status>')`, so a document whose blob the media service no longer
 * holds - answered 410, a permanent fact - read exactly like a network blip, and the vault showed a
 * generic "download failed" the member could only retry for ever. The distinction is carried as a
 * TYPE (`MediaPurgedError`, the same one every chat media surface already reads), never as a
 * sentence a call site would have to parse.
 */

import { Log } from '$lib/utils/Log';
import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';
import { MediaPurgedError } from '$lib/utils/mediaErrors';

/**
 * Fetches the packed ciphertext (`iv || ciphertext`) of a vault document.
 *
 * @param mediaId  The document's media-service id.
 * @returns        The packed bytes, ready for `unpackEncryptedBlob`.
 * @throws MediaPurgedError when the media service answers 410: the blob is gone for good and
 *         only a new upload can replace it.
 * @throws Error for any other refusal, which may be transient.
 */
export async function fetchVaultCiphertext(mediaId: string): Promise<ArrayBuffer> {
  const mediaBase = socialUrl() || '';
  const res = await apiFetch(`${mediaBase}/api/media/${encodeURIComponent(mediaId)}`);
  if (res.status === 410) {
    Log.d('vaultDownload: the media service no longer holds this document (410)');
    throw new MediaPurgedError();
  }
  if (!res.ok) {
    Log.d(`vaultDownload: refused with ${res.status}`);
    throw new Error(`Download failed: ${res.status}`);
  }
  return res.arrayBuffer();
}
