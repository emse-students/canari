/** A point in the source media's normalized coordinate space. */
export interface ReelPoint {
  x: number;
  y: number;
}

/** A freehand stroke painted over a capture. */
export interface ReelStroke {
  color: string;
  width: number;
  points: ReelPoint[];
}

/** Text painted over a capture. Coordinates and size are normalized to the source frame. */
export interface ReelText {
  color: string;
  size: number;
  text: string;
  x: number;
  y: number;
}

/** All decorations the camera editor can apply to a capture. */
export interface ReelEdits {
  strokes: ReelStroke[];
  texts: ReelText[];
}

/** The editor's output, with decorations baked into the media before upload. */
export interface EditedReelMedia {
  blob: Blob;
  width: number;
  height: number;
}

function drawDecorations(
  context: CanvasRenderingContext2D,
  edits: ReelEdits,
  width: number,
  height: number,
  fontFamily: string
) {
  for (const stroke of edits.strokes) {
    if (stroke.points.length === 0) continue;
    context.beginPath();
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.width * Math.min(width, height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
    for (const point of stroke.points.slice(1)) {
      context.lineTo(point.x * width, point.y * height);
    }
    context.stroke();
  }

  for (const text of edits.texts) {
    context.fillStyle = text.color;
    context.font = `700 ${text.size * Math.min(width, height)}px ${fontFamily}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text.text, text.x * width, text.y * height);
  }
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
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas is unavailable');
  context.drawImage(image, 0, 0);
  drawDecorations(context, edits, canvas.width, canvas.height, fontFamily);
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
    drawDecorations(context, edits, canvas.width, canvas.height, fontFamily);
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
