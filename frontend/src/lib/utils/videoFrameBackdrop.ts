import { Log } from '$lib/utils/Log';

/** Width of the backdrop frame. The backdrop is blurred (`blur-2xl`), so more pixels would be wasted. */
const BACKDROP_WIDTH = 48;

/**
 * One decoded frame of a playing or loaded video as a tiny JPEG data URL, for the blurred backdrop
 * behind a contained clip (`BlurredBackdrop`).
 *
 * DRAWN ONCE, FROM THE ELEMENT THAT IS ALREADY DECODING: no second `<video>`, no second stream, no
 * second download. Cost: one `drawImage` into a 48 px-wide canvas and one `toDataURL` - well under a
 * millisecond of work and a few hundred bytes of string. A blob or MSE source is same-origin, so the
 * canvas is never tainted; if the engine refuses anyway the failure is logged and null is returned,
 * leaving the caller on its neutral card colour (no fallback picture is invented).
 */
export function captureVideoFrame(video: HTMLVideoElement): string | null {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) {
    Log.d('VIDEO', 'captureVideoFrame: no decoded frame yet');
    return null;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = BACKDROP_WIDTH;
    canvas.height = Math.max(1, Math.round((BACKDROP_WIDTH * videoHeight) / videoWidth));
    const context = canvas.getContext('2d');
    if (!context) {
      console.warn('[video] captureVideoFrame: no 2d context');
      return null;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch (err) {
    console.warn('[video] captureVideoFrame: the frame could not be read', {
      name: err instanceof Error ? err.name : String(err),
    });
    return null;
  }
}
