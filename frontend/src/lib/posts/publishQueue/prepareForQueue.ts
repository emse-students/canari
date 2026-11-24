import { preparePostMedia, type MediaService } from '$lib/media';
import { preparedMediaPlaceholder } from '$lib/reels/reelFirstFrame';
import { EncoderLeaseAbortedError, withEncoderLease } from '$lib/video/encoderLease';
import { VideoPrepareError, type PrepareVideoOptions } from '$lib/video/prepareVideoForUpload';
import type { QueuedTakePreparation } from './publishQueueStore';

/**
 * Prepares one media for the queue. A CanaReels TAKE (`take`) is prepared as the camera's publish
 * step always prepared it - capped at the reel's longest length, trimmed to its picture, its sound
 * removed when the member removed it - and under the encoder lease the outbox's chat take shares
 * (RC-13, reels-in-chat 15.2): whoever started first encodes, the other waits.
 */
export async function prepareForQueue(
  media: Pick<MediaService, 'uploadLimits'>,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
  take: QueuedTakePreparation | undefined
) {
  const isVideo = file.type.startsWith('video/');
  const limits = isVideo ? await media.uploadLimits() : null;
  const video: PrepareVideoOptions = {
    maxBytes: limits?.maxPlaintextBytes,
    onProgress,
    signal,
    ...(take
      ? {
          maxSeconds: take.maxDurationMs / 1000,
          removeAudio: take.removeAudio === true,
          // A reel loops: sound outside the picture would be a still frame on every pass.
          trimToVideo: true,
        }
      : {}),
  };
  const prepared =
    take && isVideo
      ? await withEncoderLease('publish', signal, () => preparePostMedia(file, video)).catch(
          (e: unknown) => {
            if (e instanceof EncoderLeaseAbortedError) {
              throw new VideoPrepareError('aborted', 'stopped while waiting for the encoder', {
                cause: e,
              });
            }
            throw e;
          }
        )
      : await preparePostMedia(file, video);
  // THE PICTURE TRAVELS WITH THE MEDIA (owner, 2026-11-10 for a video, 2026-11-11 for a photo: a
  // CanaReels photo page was black until its file came): a ThumbHash a reader draws before a
  // byte arrives - the server holds ciphertext and can make none. Made from the PREPARED file,
  // the one readers get. A picture or video that gets none is said by `preparedMediaPlaceholder`.
  const placeholder = await preparedMediaPlaceholder(prepared.file);
  return placeholder ? { ...prepared, placeholder } : prepared;
}
