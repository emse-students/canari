import { frameToPixels } from './reelFrame';
import { VIDEO_MAX_SHORT_SIDE } from '$lib/video/videoEncodingPlan';
import { canvasToBlob } from '$lib/utils/canvasBlob';
import { emojiSvgSrc } from '$lib/utils/emojiSvg';
import {
  emojiSize,
  fontStack,
  overlayFontSize,
  pillSize,
  textPaint,
  type ReelOverlay,
} from './reelOverlays';

/** All decorations the camera editor can apply to a capture. */
export interface ReelEdits {
  /** Text, emoji and strokes, bottom to top, each placed by a centre, a scale and a rotation. */
  overlays: ReelOverlay[];
}

/** The editor's output, with decorations baked into the media before upload. */
export interface EditedReelMedia {
  blob: Blob;
  width: number;
  height: number;
}

/** The emoji pictures an export needs, keyed by overlay id, loaded before the first frame is drawn. */
type OverlayImages = Map<string, CanvasImageSource>;

/**
 * Paints the strokes and the overlays into a frame of `width` x `height`. The overlays use the SAME
 * size formulas as the editor's preview (`reelOverlays.ts`), so what was on the screen is what is
 * published.
 */
export function drawDecorations(
  context: CanvasRenderingContext2D,
  edits: ReelEdits,
  width: number,
  height: number,
  fontFamily: string,
  images: OverlayImages
) {
  for (const overlay of edits.overlays) {
    context.save();
    const at = frameToPixels(overlay, { width, height });
    context.translate(at.x, at.y);
    context.rotate(overlay.rotation);
    if (overlay.kind === 'stroke') {
      // The points are in short-side units: the same factor sizes the line, as in the preview's SVG.
      const unit = Math.min(width, height) * overlay.scale;
      context.beginPath();
      context.strokeStyle = overlay.color;
      context.lineWidth = overlay.width * unit;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      overlay.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x * unit, point.y * unit);
        else context.lineTo(point.x * unit, point.y * unit);
      });
      context.stroke();
    } else if (overlay.kind === 'text') {
      const fontSize = overlayFontSize(width, height, overlay.scale);
      const paint = textPaint(overlay);
      context.font = `700 ${fontSize}px ${fontStack(overlay.font, fontFamily)}`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      if (paint.pill) {
        const pill = pillSize(context.measureText(overlay.text).width, fontSize);
        context.fillStyle = paint.pill;
        context.beginPath();
        context.roundRect(-pill.width / 2, -pill.height / 2, pill.width, pill.height, pill.radius);
        context.fill();
      } else {
        context.shadowColor = 'rgba(0, 0, 0, 0.6)';
        context.shadowBlur = 4;
      }
      context.fillStyle = paint.fill;
      context.fillText(overlay.text, 0, 0);
    } else {
      const image = images.get(overlay.id);
      const side = emojiSize(width, height, overlay.scale);
      if (image) context.drawImage(image, -side / 2, -side / 2, side, side);
    }
    context.restore();
  }
}

/**
 * Loads the picture of every emoji overlay. An emoji with no picture cannot be on the screen either
 * (the editor draws the same Noto SVG), so a missing one is a defect to throw, not to skip.
 */
export async function loadOverlayImages(edits: ReelEdits): Promise<OverlayImages> {
  const images: OverlayImages = new Map();
  for (const overlay of edits.overlays) {
    if (overlay.kind !== 'emoji') continue;
    const src = emojiSvgSrc(overlay.emoji);
    if (!src) throw new Error(`no picture for the emoji overlay ${overlay.id}`);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`emoji picture ${src} could not be loaded`));
      image.src = src;
    });
    images.set(overlay.id, image);
  }
  return images;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Blob {
  const blob = canvasToBlob(canvas, type, quality);
  if (!blob) throw new Error('canvas export failed');
  return blob;
}

async function loadImage(source: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('image could not be decoded'));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function renderImage(
  source: Blob,
  edits: ReelEdits,
  fontFamily: string
): Promise<EditedReelMedia> {
  const image = await loadImage(source);
  const images = await loadOverlayImages(edits);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas is unavailable');
  context.drawImage(image, 0, 0);
  drawDecorations(context, edits, canvas.width, canvas.height, fontFamily, images);
  return {
    blob: canvasBlob(canvas, 'image/webp', 0.92),
    width: canvas.width,
    height: canvas.height,
  };
}

/** Why a decorated video could not be rendered; classified at the throw, never read from a message. */
export type ReelExportFault = 'unreadable' | 'unsupported' | 'encode';

/** The typed refusal of {@link renderEditedReelMedia} for a video. */
export class ReelExportError extends Error {
  constructor(
    readonly fault: ReelExportFault,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ReelExportError';
  }
}

/**
 * The frame the edited video is rendered at: the publish size at most (short side
 * `VIDEO_MAX_SHORT_SIDE`, never upscaled), because the publish re-encodes to it anyway and a 4K
 * gallery clip would cost a 4K encode some Android encoders refuse. Even sides (H.264 4:2:0).
 */
export function editedFrameSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, VIDEO_MAX_SHORT_SIDE / Math.min(width, height));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/**
 * Paints the overlays into the frames of a video, ON THE ENGINE-NEUTRAL PATH: WebCodecs decode and
 * encode driven by mediabunny, the very pair `prepareVideoForUpload` already requires of every
 * member who publishes. The previous path played the clip into a canvas and recorded
 * `canvas.captureStream()`; WebKit has no `HTMLMediaElement.captureStream`, so on the iPhone every
 * edited video was refused (docs/wiki/frontend/modules/reel-editor.md). Nothing here needs a
 * playing element: frames are decoded, drawn and re-encoded faster than real time, with the
 * source's own audio carried over.
 */
async function renderVideo(
  source: Blob,
  edits: ReelEdits,
  fontFamily: string
): Promise<EditedReelMedia> {
  console.debug(
    `[reel-editor] video export start: ${source.type || 'typeless'}, ${source.size} bytes,` +
      ` ${edits.overlays.length} overlay(s)`
  );
  let images: OverlayImages;
  try {
    images = await loadOverlayImages(edits);
  } catch (cause) {
    console.error('[reel-editor] an overlay picture could not be loaded', cause);
    throw new ReelExportError('unreadable', 'video: an overlay picture could not be loaded', {
      cause,
    });
  }
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(source), formats: mb.ALL_FORMATS });
  try {
    let width: number;
    let height: number;
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new ReelExportError('unreadable', 'video: the file has no video track');
      width = await track.getDisplayWidth();
      height = await track.getDisplayHeight();
    } catch (cause) {
      if (cause instanceof ReelExportError) throw cause;
      console.error('[reel-editor] the take could not be read', cause);
      throw new ReelExportError('unreadable', 'video: the take could not be read', { cause });
    }
    if (!(width > 0 && height > 0)) {
      throw new ReelExportError('unreadable', 'video: the track has no frame size');
    }
    ({ width, height } = editedFrameSize(width, height));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new ReelExportError('unsupported', 'canvas is unavailable');

    const output = new mb.Output({
      format: new mb.Mp4OutputFormat(),
      target: new mb.BufferTarget(),
    });
    let conversion: Awaited<ReturnType<typeof mb.Conversion.init>>;
    try {
      conversion = await mb.Conversion.init({
        input,
        output,
        tracks: 'primary',
        showWarnings: false,
        video: {
          codec: 'avc',
          width,
          height,
          fit: 'fill',
          // High: the publish re-encodes this file once more (single-pass export is WP-E4).
          quality: mb.QUALITY_HIGH,
          allowTransformationMetadata: false,
          forceTranscode: true,
          processedWidth: width,
          processedHeight: height,
          process: (sample) => {
            context.clearRect(0, 0, width, height);
            sample.draw(context, 0, 0, width, height);
            drawDecorations(context, edits, width, height, fontFamily, images);
            return canvas;
          },
        },
      });
    } catch (cause) {
      console.error('[reel-editor] the conversion could not be set up', cause);
      throw new ReelExportError('unsupported', 'video: the conversion could not be set up', {
        cause,
      });
    }
    // A DROPPED TRACK IS A REFUSAL, never a quieter video: `isValid` stays true when the audio
    // alone is dropped (no AAC encoder), so the discarded list is the fact, as in prepareVideoForUpload.
    if (!conversion.isValid || conversion.discardedTracks.length > 0) {
      const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
      console.warn(`[reel-editor] this engine cannot render the take: ${why}`);
      throw new ReelExportError('unsupported', `video: cannot render on this engine - ${why}`);
    }
    try {
      await conversion.execute();
    } catch (cause) {
      console.error('[reel-editor] the encoder failed', cause);
      throw new ReelExportError('encode', 'video: the encoder failed', { cause });
    }
    const buffer = output.target.buffer;
    if (!buffer) throw new ReelExportError('encode', 'video: the muxer produced no bytes');
    let mimeType: string;
    try {
      mimeType = await output.getMimeType();
    } catch (cause) {
      console.error('[reel-editor] the output type could not be read', cause);
      throw new ReelExportError('encode', 'video: the output type could not be read', { cause });
    }
    const blob = new Blob([buffer], { type: mimeType });
    console.debug(`[reel-editor] video export done: ${blob.size} bytes, ${width}x${height}`);
    return { blob, width, height };
  } finally {
    input.dispose();
  }
}

/** Renders the camera editor's decorations into an uploadable image or video. */
export function renderEditedReelMedia(
  source: Blob,
  edits: ReelEdits,
  fontFamily = 'Nunito Variable, Nunito, sans-serif'
): Promise<EditedReelMedia> {
  return source.type.startsWith('image/')
    ? renderImage(source, edits, fontFamily)
    : renderVideo(source, edits, fontFamily);
}
