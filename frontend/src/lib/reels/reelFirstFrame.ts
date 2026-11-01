/**
 * A REEL'S FIRST FRAME, DECODED ON THE DEVICE FROM THE VIDEO'S OWN BYTES.
 *
 * The server transcodes nothing and draws no thumbnail (CanaReels C3), and a feed reel's blob is
 * AES-GCM ciphertext there, so the only picture of a reel that exists before playback is one a
 * client makes from bytes it already decrypted. Two callers:
 *
 * - the PUBLISHER, once, on the prepared file: a ThumbHash of the first frame rides in the post's
 *   media entry (`MediaRef.placeholder`), so every reader paints the blurred frame from the first
 *   paint, before a byte of the video arrives (`firstFramePlaceholder`);
 * - the READER, on a reel already in its cache (the preloaded next one, the one just watched): the
 *   sharp frame, kept for the session (`reelPosters.svelte.ts`).
 *
 * Decoded by mediabunny - the demuxer and decoder the re-encode already loads - rather than a
 * detached `<video>`: an element would need a `loadeddata` that iOS does not fire without a `play()`,
 * and a mounted one claims playback from the reel being watched (`followVideoSound`). Nothing here
 * throws: a missing frame costs a poster, never the reel.
 */

/** The poster's long edge, in px: sharp on a phone screen, a few tens of kB as JPEG. */
export const REEL_POSTER_LONG_EDGE = 720;

/** The canvas a decode hands back. */
export type FrameCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * The first frame of `video`, scaled to fit `longEdge` with its rotation applied, or `null` when
 * the file has no video track this engine can decode.
 */
export async function decodeFirstFrame(video: Blob, longEdge: number): Promise<FrameCanvas | null> {
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(video), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      console.warn(`[reel-frame] ${video.type || 'typeless'}: no video track to draw a frame from`);
      return null;
    }
    if (!(await track.canDecode())) {
      console.warn(`[reel-frame] ${track.codec ?? 'unknown codec'}: this engine cannot decode it`);
      return null;
    }
    const w = track.displayWidth;
    const h = track.displayHeight;
    const scale = Math.min(1, longEdge / Math.max(w, h, 1));
    const sink = new mb.CanvasSink(track, {
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale)),
      fit: 'fill',
    });
    const first = await track.getFirstTimestamp();
    const wrapped = await sink.getCanvas(first);
    if (!wrapped) console.warn('[reel-frame] the track yielded no frame at its first timestamp');
    return wrapped?.canvas ?? null;
  } catch (err) {
    console.warn('[reel-frame] first frame not decoded', err);
    return null;
  } finally {
    input.dispose();
  }
}

/** Encodes a decoded frame as a JPEG, or `null` when the engine encodes nothing. */
export async function frameToJpeg(canvas: FrameCanvas, quality = 0.8): Promise<Blob | null> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality }).catch((err: unknown) => {
      console.warn('[reel-frame] frame not encoded', err);
      return null;
    });
  }
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

/**
 * The ThumbHash (base64) of the first frame of the video the publisher is about to upload, or
 * `null` - the reel is published without one and readers draw a plain dark box until its frame.
 */
export async function firstFramePlaceholder(video: Blob): Promise<string | null> {
  const { encodeMediaPlaceholder } = await import('$lib/utils/mediaPlaceholder');
  const canvas = await decodeFirstFrame(video, 100);
  if (!canvas) return null;
  const hash = encodeMediaPlaceholder(canvas, canvas.width, canvas.height);
  console.debug(`[reel-frame] first-frame placeholder ${hash ? 'made' : 'not made'}`);
  return hash;
}
