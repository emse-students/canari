import { m } from '$lib/paraglide/messages';
import type { OutboxEntry } from '$lib/db/types';
import type { ReelLimits } from '$lib/posts/api';
import type { PrepareVideoOptions, PreparedVideo } from '$lib/video/prepareVideoForUpload';
import { OutboxPrepareRefusedError, type PreparedOutboxMedia } from '$lib/utils/chat/outbox';

/** What the preparation reads and runs, injectable so a test can refuse the cap or count the encoder. */
export interface PrepareQueuedChatReelDeps {
  /** media-service's plaintext ceiling (`MediaService.uploadLimits`). */
  uploadLimits: () => Promise<{ maxPlaintextBytes: number } | null>;
  /** The server's reel numbers (`getReelLimits`), the one copy of the chat cap. */
  reelLimits: () => Promise<ReelLimits>;
  /** The encoder (`prepareVideoForUpload`). */
  prepare: (source: Blob, options: PrepareVideoOptions) => Promise<PreparedVideo>;
}

async function defaultDeps(): Promise<PrepareQueuedChatReelDeps> {
  const [{ MediaService }, { prepareVideoForUpload }, { getReelLimits }] = await Promise.all([
    import('$lib/media'),
    import('$lib/video/prepareVideoForUpload'),
    import('$lib/posts/api'),
  ]);
  return {
    uploadLimits: () => new MediaService().uploadLimits(),
    reelLimits: getReelLimits,
    prepare: prepareVideoForUpload,
  };
}

/**
 * Prepares a queued RAW chat-reel take for the outbox (RC-5, `OutboxDeps.prepareMedia`) at the CHAT
 * profile and under the server's chat cap (RC-3, `chatReelPrepareOptions`), the server's plaintext
 * ceiling as its budget.
 *
 * - The caps are read BEFORE the encoder runs. One that cannot be read (offline, a 5xx) or an answer
 *   without the chat cap (`ChatReelCapMissingError`) is an ORDINARY failure: the outbox parks the take
 *   (kept, Retry), and it is never prepared without its cap nor under the 90 s reel cap instead.
 * - A cancel is re-thrown as the outbox's `UploadAbortedError`, the member's act, never a failure.
 * - A FACT of the take or the engine (`isUnpreparableFault`) is `OutboxPrepareRefusedError`: failed
 *   for good with the composer's own sentence for it.
 */
export async function prepareQueuedChatReel(
  media: NonNullable<OutboxEntry['media']>,
  opts: { signal: AbortSignal; onProgress: (fraction: number) => void },
  depsIn?: PrepareQueuedChatReelDeps
): Promise<PreparedOutboxMedia> {
  const [
    deps,
    { isVideoPrepareError },
    { UploadAbortedError },
    messages,
    { chatReelPrepareOptions },
  ] = await Promise.all([
    depsIn ?? defaultDeps(),
    import('$lib/video/prepareVideoForUpload'),
    import('$lib/utils/uploadXhr'),
    import('$lib/video/videoPrepareMessages'),
    import('$lib/reels/chatReelWriter'),
  ]);
  const [limits, reelLimits] = await Promise.all([deps.uploadLimits(), deps.reelLimits()]);
  // Throws `ChatReelCapMissingError` (ordinary: the take is parked) before a frame is encoded.
  const capOptions = chatReelPrepareOptions(reelLimits, limits?.maxPlaintextBytes);
  const raw = media.fileBytes ?? new Uint8Array(0);
  const source = new File([raw.buffer as ArrayBuffer], media.fileName ?? 'take', {
    type: media.mimeType,
  });
  try {
    const prepared = await deps.prepare(source, {
      ...capOptions,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    return {
      bytes: new Uint8Array(await prepared.file.arrayBuffer()),
      mimeType: prepared.file.type,
      fileName: prepared.file.name,
      width: prepared.width,
      height: prepared.height,
      durationMs: Math.max(1, Math.round(prepared.durationSeconds * 1000)),
    };
  } catch (e) {
    if (isVideoPrepareError(e) && e.fault === 'aborted') {
      throw new UploadAbortedError(opts.signal.reason);
    }
    // A FACT OF THE TAKE OR THE ENGINE, classified here at the throw by its typed fault: failed for
    // good with the composer's own sentence for it, never a retry that is refused the same way.
    if (isVideoPrepareError(e) && messages.isUnpreparableFault(e.fault)) {
      throw new OutboxPrepareRefusedError(
        messages.videoPrepareFailureMessage(e) ?? m.video_prepare_failed(),
        e
      );
    }
    throw e;
  }
}
