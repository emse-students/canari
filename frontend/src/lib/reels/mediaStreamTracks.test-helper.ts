/**
 * happy-dom's `MediaStream` has `getVideoTracks` and `getAudioTracks` but no `getTracks`, which every
 * browser has and `releaseCamera` calls. A test that lets the session build a real `MediaStream` (a
 * lens flip during a take) gives the prototype the browser's method for the file's duration.
 */
export function giveMediaStreamGetTracks(): void {
  const proto = MediaStream.prototype as MediaStream & { getTracks?: () => MediaStreamTrack[] };
  if (typeof proto.getTracks === 'function') return;
  Object.defineProperty(proto, 'getTracks', {
    configurable: true,
    value(this: MediaStream) {
      return [...this.getVideoTracks(), ...this.getAudioTracks()];
    },
  });
}
