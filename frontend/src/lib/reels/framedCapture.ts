/**
 * What the capture screen SAVES is what its preview SHOWED: the same crop, at no more than the
 * phone's screen can display (CanaReels capture, user report of 2026-10-05).
 *
 * THE CAUSES THIS REPLACES, found in the code of the shutter it had:
 * - The photo and the take were the SENSOR's frame (a 4:3 or 16:9 mode), while the preview is that
 *   frame under `object-fit: cover` in a box with the phone's aspect - so a person saw a tall frame
 *   and kept a different one. Both are now cropped to the preview box's rectangle, computed once
 *   here ({@link coverCropRect}) and drawn through a canvas.
 * - The request asked 1280x720 whatever the screen, and the recorder encoded the sensor's whole
 *   frame in software. The capture is now constrained to the screen's own pixel count, capped
 *   ({@link REEL_CAPTURE_MAX_LONG_SIDE}), and the bitrate follows the pixels ({@link videoBitrateFor}).
 *
 * MIRRORING (user report of 2026-10-07: the photo came out "inverted"). The front lens PREVIEW is
 * mirrored by CSS, as every camera app shows it. A canvas `drawImage` of the `<video>` reads the
 * decoded frame, never the CSS transform, so the saved photo was the un-mirrored frame: left and right
 * swapped against what the member had just looked at, and against the review that follows. The saved
 * photo and take now REPRODUCE THE PREVIEW (WYSIWYG, Snapchat's convention): the front lens is drawn
 * flipped horizontally ({@link shouldMirrorCapture}), the rear lens never. The sensor's frame is never
 * rotated - the engine delivers it upright, and a canvas read applies no EXIF.
 */

/** A width and a height, in whatever unit the caller states. */
export interface Size {
  width: number;
  height: number;
}

/** A source rectangle for `drawImage`. */
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The longest side, in pixels, of anything the capture saves. 1280 is what the upload is prepared to
 * (720p, C3), so more would only cost the encoder and be thrown away by the preparation.
 */
export const REEL_CAPTURE_MAX_LONG_SIDE = 1280;

/** The frame rate asked of the camera and of the framed stream. */
export const REEL_CAPTURE_FPS = 30;

/** The most a take is recorded at: above the 2.5 Mb/s upload target, so the preparation compresses once. */
export const REEL_RECORD_BITRATE_MAX = 4_000_000;

/** Bits per pixel per frame the take is recorded at; 4 Mb/s at 720x1280x30 fps, less on a smaller frame. */
const BITS_PER_PIXEL_FRAME = 0.15;

/** The JPEG quality of a photo. */
const PHOTO_QUALITY = 0.92;

/** The largest even integer not above `value` (encoders reject odd dimensions), at least 2. */
function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * The part of a `src` frame that `object-fit: cover` shows in a `box`: the largest centred rectangle
 * of the box's aspect ratio. This IS the preview's crop, so saving it saves what was seen.
 */
export function coverCropRect(src: Size, box: Size): CropRect {
  if (src.width <= 0 || src.height <= 0 || box.width <= 0 || box.height <= 0) {
    throw new RangeError('coverCropRect: every dimension must be positive');
  }
  const srcAspect = src.width / src.height;
  const boxAspect = box.width / box.height;
  if (srcAspect > boxAspect) {
    // The frame is wider than the box: the sides are cut.
    const sw = src.height * boxAspect;
    return { sx: (src.width - sw) / 2, sy: 0, sw, sh: src.height };
  }
  const sh = src.width / boxAspect;
  return { sx: 0, sy: (src.height - sh) / 2, sw: src.width, sh };
}

/**
 * The saved frame's size: the preview box's aspect, at most the screen's own pixels (`box x dpr`),
 * at most {@link REEL_CAPTURE_MAX_LONG_SIDE}, and never more than the crop actually holds (an
 * upscale adds bytes and no detail). Even dimensions.
 */
export function framedOutputSize(box: Size, dpr: number, crop: CropRect): Size {
  const boxLong = Math.max(box.width, box.height);
  const boxShort = Math.min(box.width, box.height);
  const cropLong = Math.max(crop.sw, crop.sh);
  const long = even(Math.min(REEL_CAPTURE_MAX_LONG_SIDE, boxLong * dpr, cropLong));
  const short = even((long * boxShort) / boxLong);
  return box.width >= box.height ? { width: long, height: short } : { width: short, height: long };
}

/**
 * What `getUserMedia` is asked for: the screen's pixel count (`screen x dpr`) capped at
 * {@link REEL_CAPTURE_MAX_LONG_SIDE}, in the aspect of the screen, stated LANDSCAPE as the sensors
 * list their modes (both phones answered it as a portrait track, measured 2026-10-01).
 */
export function cameraVideoConstraints(
  screen: Size,
  dpr: number
): { width: number; height: number; frameRate: number } {
  const long = even(
    Math.min(REEL_CAPTURE_MAX_LONG_SIDE, Math.max(screen.width, screen.height) * dpr)
  );
  const short = even(
    (long * Math.min(screen.width, screen.height)) / Math.max(screen.width, screen.height)
  );
  return { width: long, height: short, frameRate: REEL_CAPTURE_FPS };
}

/** The recorder's bitrate for a frame of `size`: proportional to the pixels, never above the cap. */
export function videoBitrateFor(size: Size, fps: number = REEL_CAPTURE_FPS): number {
  return Math.min(
    REEL_RECORD_BITRATE_MAX,
    Math.round(size.width * size.height * fps * BITS_PER_PIXEL_FRAME)
  );
}

/** What the camera screen offers its shutter: both captures are the preview's crop, mirrored as it is. */
export interface CameraCapture {
  /** A decoded frame is on screen: nothing can be captured before this. */
  readonly ready: boolean;
  /** One photo, or `null` (logged) when none could be made. */
  photo(): Promise<Blob | null>;
  /** The preview's crop as a stream to record, or `null` (logged) when none could be made. */
  startFramedStream(): FramedStream | null;
}

/** The preview element's box, the pixel ratio and the lens: everything a capture needs besides the frame. */
export interface PreviewBox {
  width: number;
  height: number;
  dpr: number;
  /** The preview is mirrored on screen, so the capture is drawn mirrored too ({@link shouldMirrorCapture}). */
  mirror: boolean;
}

/** Whether a capture from `facing` is drawn flipped: exactly when the preview is (the front lens). */
export function shouldMirrorCapture(facing: 'user' | 'environment'): boolean {
  return facing === 'user';
}

function cropFor(video: HTMLVideoElement, box: PreviewBox): { crop: CropRect; out: Size } {
  const crop = coverCropRect(
    { width: video.videoWidth, height: video.videoHeight },
    { width: box.width, height: box.height }
  );
  return { crop, out: framedOutputSize(box, box.dpr, crop) };
}

/** Draws the crop into the canvas, flipped horizontally when `mirror` (the transform is undone after). */
export function draw(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  crop: CropRect,
  out: Size,
  mirror: boolean
): void {
  if (mirror) {
    context.save();
    context.translate(out.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, out.width, out.height);
  if (mirror) context.restore();
}

/**
 * One photo: the preview's crop of the current frame, as a JPEG.
 * Resolves `null` (logged) when the canvas cannot encode it.
 */
export function takeFramedPhoto(video: HTMLVideoElement, box: PreviewBox): Promise<Blob | null> {
  const { crop, out } = cropFor(video, box);
  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  const context = canvas.getContext('2d');
  if (!context) {
    console.error('[framed-capture] photo: no canvas context');
    return Promise.resolve(null);
  }
  draw(context, video, crop, out, box.mirror);
  console.debug(
    `[framed-capture] photo ${out.width}x${out.height} from ${video.videoWidth}x${video.videoHeight}` +
      ` mirror=${box.mirror}`
  );
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) console.error('[framed-capture] photo: the canvas produced no blob');
        resolve(blob);
      },
      'image/jpeg',
      PHOTO_QUALITY
    );
  });
}

/**
 * The preview's crop as a live stream: the video is drawn into a canvas on every display frame, and
 * the canvas's stream (plus the original audio) is what the recorder records. It is the only way to
 * record a CROP - a `MediaRecorder` has no crop of its own - and it keeps the recorded size at the
 * screen's, whatever mode the sensor picked.
 */
export class FramedStream {
  readonly stream: MediaStream;
  readonly size: Size;
  readonly bitrate: number;
  #frame: number | null = null;
  #stopped = false;

  private constructor(
    video: HTMLVideoElement,
    box: PreviewBox,
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    crop: CropRect,
    audio: MediaStreamTrack[]
  ) {
    this.size = { width: canvas.width, height: canvas.height };
    this.bitrate = videoBitrateFor(this.size);
    const canvasStream = canvas.captureStream(REEL_CAPTURE_FPS);
    this.stream = new MediaStream([...canvasStream.getVideoTracks(), ...audio]);
    // The box and the sensor mode do not change during a take (the lens is locked), so the crop is
    // computed once and the loop only draws.
    const tick = () => {
      if (this.#stopped) return;
      draw(context, video, crop, this.size, box.mirror);
      this.#frame = requestAnimationFrame(tick);
    };
    draw(context, video, crop, this.size, box.mirror);
    this.#frame = requestAnimationFrame(tick);
    console.debug(
      `[framed-capture] take ${this.size.width}x${this.size.height} at ${this.bitrate} b/s ` +
        `from ${video.videoWidth}x${video.videoHeight} (box ${box.width}x${box.height} @${box.dpr})`
    );
  }

  /**
   * @param video The live preview element, holding a decoded frame.
   * @param box Its layout box and the device pixel ratio.
   * @param audio The microphone track(s) of the camera stream.
   * @returns `null` (logged) when there is no canvas to draw on.
   */
  static start(
    video: HTMLVideoElement,
    box: PreviewBox,
    audio: MediaStreamTrack[]
  ): FramedStream | null {
    const { crop, out } = cropFor(video, box);
    const canvas = document.createElement('canvas');
    canvas.width = out.width;
    canvas.height = out.height;
    const context = canvas.getContext('2d');
    if (!context || typeof canvas.captureStream !== 'function') {
      console.error('[framed-capture] take: no canvas context or no canvas.captureStream');
      return null;
    }
    return new FramedStream(video, box, canvas, context, crop, audio);
  }

  /** Stops drawing and the canvas's own track; the audio belongs to the camera session. */
  stop(): void {
    this.#stopped = true;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    for (const track of this.stream.getVideoTracks()) track.stop();
    console.debug('[framed-capture] take stream stopped');
  }
}
