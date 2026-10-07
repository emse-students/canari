/**
 * Encodes a canvas to a `Blob` SYNCHRONOUSLY, because `HTMLCanvasElement.toBlob` is not usable on the
 * Android WebView (Mi 9T, WebView 152, measured 2026-10-07 through the app's own DevTools socket).
 *
 * `toBlob` hands the encode to the engine's idle scheduling, and on that WebView it completes after
 * a flat ~4.0 s whatever the canvas holds: a 16x16 canvas, an empty PNG, a 588x1164 photo, with the
 * camera live or stopped, on the camera screen or the dashboard (4048, 4006, 4011, 4056 ms).
 * `toDataURL`, the same encoder run on the calling task, took 41 ms for the photo. A CanaReels photo
 * therefore took 4 s to reach its review (user report of 2026-10-07: "taking a photo is slow").
 * iOS WebKit has no such wait.
 *
 * The bytes are the same; only WHEN the encode runs differs. The main thread pays the encode (tens of
 * milliseconds at the sizes this app saves) instead of waiting for an idle slot that does not come.
 */

/** Decodes a `data:<mime>;base64,<payload>` URL into a Blob; `null` when it is not one. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

/**
 * The canvas as an encoded Blob of `type` (the engine may answer another type it can encode, as
 * `toBlob` does - read `blob.type`), or `null` (logged) when the canvas produced nothing.
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Blob | null {
  const blob = dataUrlToBlob(canvas.toDataURL(type, quality));
  if (!blob || blob.size === 0) {
    console.error(`[canvas-blob] ${canvas.width}x${canvas.height} ${type} produced no bytes`);
    return null;
  }
  return blob;
}
