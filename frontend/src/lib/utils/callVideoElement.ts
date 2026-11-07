import { appendLog } from '$lib/utils/sessionLog';

/**
 * ONE BINDING OF A CALL `<video>` TO ONE TRACK, shared by every picture of a call: the peer's on the
 * full screen and in the top bar's thumbnail, and the self view (`CallOverlay`, `CallBanner`).
 *
 * WHAT IT ANSWERS (2026-11-07, production): a remote video track can be live AND unmuted - its RTP
 * packets arrive - while not one frame of it decodes (an iPhone and an Android framing E2E video
 * differently, every frame a decrypt failure). The picture was shown on the track's word alone, so
 * the owner saw a plain BLACK square. So a picture is shown only once the element has a frame to
 * paint (`loadeddata`: the media element's own "the first frame is available"), and the caller shows
 * the peer's avatar until then - `onFirstFrame` is how it learns.
 *
 * AN `AbortError` FROM `play()` IS THE BINDING'S OWN RELEASE, NEVER A FAILURE. Assigning
 * `srcObject` (here, at release) or taking the element out of the document runs the media element's
 * load or pause steps, which reject a `play()` still pending with `AbortError` - Chromium words it
 * "interrupted by a new load request", WebKit "The operation was aborted". Each bind/release cycle
 * of a picture (minimise, a camera switch, the peer's camera off and on) produced one such line,
 * logged as "did not start" while nothing had failed. The two facts that make it ours are known
 * here: this binding was released, or the element left the document. Any other rejection - and an
 * `AbortError` on an element still bound and in the document - is logged as the failure it is.
 *
 * Returns the release, for an effect's cleanup.
 */
export function bindCallVideo(
  el: HTMLVideoElement,
  track: MediaStreamTrack,
  what: string,
  onFirstFrame?: () => void
): () => void {
  let released = false;
  const firstFrame = () => {
    if (!released) onFirstFrame?.();
  };
  // Assigning a new `srcObject` resets the element to HAVE_NOTHING, so `loadeddata` always comes
  // after this line for this binding's own first frame.
  el.srcObject = new MediaStream([track]);
  if (onFirstFrame) el.addEventListener('loadeddata', firstFrame, { once: true });
  el.play().catch((e: unknown) => {
    if (isOwnRelease(e, released, el)) return;
    appendLog(`[Call] ${what} did not start: ${String(e)}`);
  });
  return () => {
    released = true;
    el.removeEventListener('loadeddata', firstFrame);
    el.srcObject = null;
  };
}

/**
 * Whether a `play()` rejection is the consequence of this binding's own release (see
 * {@link bindCallVideo}): an `AbortError` - the DOMException TYPE, never its message - on a binding
 * already released or an element no longer in the document.
 */
export function isOwnRelease(e: unknown, released: boolean, el: { isConnected: boolean }): boolean {
  const aborted = e instanceof DOMException && e.name === 'AbortError';
  return aborted && (released || !el.isConnected);
}
