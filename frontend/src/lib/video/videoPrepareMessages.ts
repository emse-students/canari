/**
 * The sentence a member reads for each way a video can fail to be prepared - the one mapping from
 * `VideoPrepareFault` to Paraglide, shared by the post composer, the post editor, the chat composer
 * and the CanaReels camera, so no screen spells its own.
 */
import { m } from '$lib/paraglide/messages';
import type { VideoPrepareError, VideoPrepareFault } from './prepareVideoForUpload';

/**
 * The sentence for a refused video, or `null` for `aborted` - a cancel the member asked for is not
 * a failure and shows nothing.
 */
export function videoPrepareFailureMessage(error: VideoPrepareError): string | null {
  switch (error.fault) {
    case 'aborted':
      return null;
    case 'unreadable':
    case 'no-video-track':
      return m.video_prepare_unreadable();
    case 'too-long':
    case 'too-large':
      return m.video_prepare_too_long();
    case 'unsupported':
      return m.video_prepare_unsupported();
    case 'encode':
      return m.video_prepare_failed();
  }
}

/**
 * Whether a fault is a FACT of the take or of this engine, so preparing the same take again on the
 * same device is refused the same way (a queued chat reel then fails for good, RC-5). `encode` - the
 * encoder or muxer failing while working - is the one left retryable: a device under memory pressure
 * can succeed later. `aborted` is the member's act, not a refusal.
 */
export function isUnpreparableFault(fault: VideoPrepareFault): boolean {
  switch (fault) {
    case 'unreadable':
    case 'no-video-track':
    case 'too-long':
    case 'unsupported':
    case 'too-large':
      return true;
    case 'encode':
    case 'aborted':
      return false;
  }
}

/** The progress line, as a whole percentage. */
export function videoPrepareProgressLabel(fraction: number): string {
  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return m.video_prepare_progress({ percent });
}
