/**
 * What a picked video is, read from its own metadata before anything else is done with it - so a
 * gallery video over the reel cap (C4), or one that is not vertical (owner, 2026-11-09), is refused the
 * moment it is picked, not after a minute of preparing it.
 *
 * Each field is `null` when the engine cannot say: a file it cannot decode, or a container with no
 * duration in its header (a recorder's WebM reports `Infinity`). That is not a refusal - the
 * preparation reads the container itself and refuses a long one with its own `too-long` fault, and the
 * publish reads the PREPARED frame (`publishReel`), which is the one the server is told.
 *
 * `width`/`height` are the element's `videoWidth`/`videoHeight`: the frame as DISPLAYED, the
 * container's rotation applied by the engine (Chromium and WebKit both do), which is what "vertical"
 * means.
 */
export interface PickedVideoMetadata {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

/** Reads a picked video's length and displayed frame; never throws. */
export function readVideoMetadata(file: Blob): Promise<PickedVideoMetadata> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const done = (metadata: PickedVideoMetadata) => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(metadata);
    };
    video.onloadedmetadata = () => {
      const seconds = video.duration;
      const durationMs =
        Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
      if (durationMs === null) {
        console.debug(`[reels] ${file.type || 'unknown'} reports no finite duration`);
      }
      const width = video.videoWidth > 0 ? video.videoWidth : null;
      const height = video.videoHeight > 0 ? video.videoHeight : null;
      if (width === null || height === null) {
        console.debug(`[reels] ${file.type || 'unknown'} reports no frame size`);
      }
      done({ durationMs, width, height });
    };
    video.onerror = () => {
      console.warn(`[reels] ${file.type || 'unknown'} has no readable metadata`);
      done({ durationMs: null, width: null, height: null });
    };
    video.src = url;
  });
}
