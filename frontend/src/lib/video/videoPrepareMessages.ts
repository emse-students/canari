/**
 * The sentence a member reads for each way a video can fail to be prepared - the one mapping from
 * `VideoPrepareFault` to Paraglide, shared by the post composer, the post editor, the chat composer
 * and the CanaReels camera, so no screen spells its own.
 */
import { m } from '$lib/paraglide/messages';
import type { VideoPrepareError } from './prepareVideoForUpload';

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

/** The progress line, as a whole percentage. */
export function videoPrepareProgressLabel(fraction: number): string {
  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return m.video_prepare_progress({ percent });
}
