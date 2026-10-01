/**
 * How long a picked video is, read from its own metadata before anything else is done with it - so a
 * gallery video over the reel cap (C4) is refused the moment it is picked, not after a minute of
 * preparing it.
 *
 * `null` when the engine cannot say: a file it cannot decode, or a container with no duration in its
 * header (a recorder's WebM reports `Infinity`). That is not a refusal - the preparation reads the
 * container itself and refuses a long one with its own `too-long` fault.
 */
export function readVideoDurationMs(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const done = (ms: number | null) => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    video.onloadedmetadata = () => {
      const seconds = video.duration;
      if (Number.isFinite(seconds) && seconds > 0) done(Math.round(seconds * 1000));
      else {
        console.debug(`[reels] ${file.type || 'unknown'} reports no finite duration`);
        done(null);
      }
    };
    video.onerror = () => {
      console.warn(`[reels] ${file.type || 'unknown'} has no readable metadata`);
      done(null);
    };
    video.src = url;
  });
}
