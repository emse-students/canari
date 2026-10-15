/**
 * The thumbnail of a video FILMED by the in-app camera, attached to the file the camera hands to a
 * composer.
 *
 * WHY A SEPARATE PICTURE. The composer draws a picked video's first frame by seeking its `<video>` to
 * `#t=0.1` (`PickedMediaPreview`). A MediaRecorder file carries no seek index (WebM/Matroska cues),
 * so the Android WebView decodes no frame of it and the tile stayed the engine's flat grey (Mi 9T,
 * v1.2.9-alpha.1). The camera already holds the right picture - the preview's crop as the recording
 * starts (`ReelClip.poster`) - so it hands it along instead of the composer guessing at a frame.
 *
 * KEYED BY THE FILE ITSELF (a `WeakMap`), so the composers' one attachment path (`File[]`) carries it
 * unchanged, and a file nobody holds any more takes its picture with it.
 */
const posters = new WeakMap<File, Blob>();

/** Records `poster` as the thumbnail of the filmed `file`. */
export function attachCapturePoster(file: File, poster: Blob): void {
  console.debug(`[capture-poster] ${file.name}: ${poster.size}-byte thumbnail attached`);
  posters.set(file, poster);
}

/** The thumbnail the camera attached to `file`, or `undefined` for any file it did not film. */
export function capturePosterOf(file: File): Blob | undefined {
  return posters.get(file);
}
