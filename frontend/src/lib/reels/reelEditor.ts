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
    context.translate(overlay.x * width, overlay.y * height);
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

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas export failed'))),
      type,
      quality
    );
  });
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
    blob: await canvasBlob(canvas, 'image/webp', 0.92),
    width: canvas.width,
    height: canvas.height,
  };
}

async function loadVideo(source: Blob): Promise<HTMLVideoElement> {
  const url = URL.createObjectURL(source);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('video could not be decoded'));
  });
  return video;
}

async function renderVideo(
  source: Blob,
  edits: ReelEdits,
  fontFamily: string
): Promise<EditedReelMedia> {
  const video = await loadVideo(source);
  const images = await loadOverlayImages(edits);
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  const captureVideo = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
  };
  if (
    !context ||
    !captureVideo.captureStream ||
    !canvas.captureStream ||
    typeof MediaRecorder === 'undefined'
  ) {
    throw new Error('video editing is unavailable on this device');
  }

  const canvasStream = canvas.captureStream(30);
  const sourceStream = captureVideo.captureStream();
  for (const track of sourceStream.getAudioTracks()) canvasStream.addTrack(track);
  const mimeType = ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type)
  );
  if (!mimeType) throw new Error('video export is unavailable on this device');

  const recorder = new MediaRecorder(canvasStream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const result = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('video export failed'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  const draw = () => {
    if (video.ended) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawDecorations(context, edits, canvas.width, canvas.height, fontFamily, images);
    requestAnimationFrame(draw);
  };
  video.onended = () => recorder.stop();
  recorder.start(200);
  await video.play();
  draw();
  const blob = await result;
  URL.revokeObjectURL(video.src);
  return { blob, width: canvas.width, height: canvas.height };
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
