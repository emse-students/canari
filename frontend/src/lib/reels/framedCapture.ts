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
 * flipped horizontally ({@link shouldMirrorCapture}), the rear lens never.
 *
 * TURNING (owner, 2026-11-11). The engine delivers the frame upright FOR THE SCREEN, and the camera's
 * screen stays portrait however the phone is held (screen-orientation.md, "The camera keeps its
 * layout"). A phone held sideways therefore films a portrait frame with the world lying on its side;
 * the capture is TURNED by {@link PreviewBox.turn} (the phone's quarter turn, read from the sensor) so
 * the file comes out the way the phone was held - a landscape photo or take, as a system camera
 * makes. A canvas read applies no EXIF, so the turn is drawn into the pixels.
 */
import type { Quadrant } from '$lib/mobile/cameraHardware.svelte';
import { canvasToBlob } from '$lib/utils/canvasBlob';
import { digitalZoomCrop } from './cameraZoom';

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

/**
 * The microphone a reel is recorded with: NO voice-call processing. Echo cancellation, noise
 * suppression and automatic gain are a telephone's chain - they gate music and ambience, pump the
 * level and, with the gain, pushed the user's reel to -10 LUFS with its peak over 0 dBFS (2026-10-09).
 * Measured on the Mi 9T against one loud source, 6 s: gain control alone read 6 dB hotter than none
 * (peak -10.9 against -17.1 dBFS). A reel records the room as it is, as a camera app does.
 */
export const REEL_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  // ONE channel: without voice processing a phone mic can answer two channels with the second one
  // empty, and the recorder then writes a stereo file that plays out of one side only. A mono track
  // plays on both sides everywhere (utils/audioLayout.ts reads back what the engine granted).
  channelCount: { ideal: 1 },
};

/** Audio bitrate asked of the recorder, so its Opus is not left at an engine default. */
export const REEL_RECORD_AUDIO_BITRATE = 128_000;

/** The most a take is recorded at: above the 2.5 Mb/s upload target, so the preparation compresses once. */
export const REEL_RECORD_BITRATE_MAX = 4_000_000;

/** Bits per pixel per frame the take is recorded at; 4 Mb/s at 720x1280x30 fps, less on a smaller frame. */
const BITS_PER_PIXEL_FRAME = 0.15;

/** The JPEG quality of a photo. */
const PHOTO_QUALITY = 0.92;
/**
 * A take's THUMBNAIL (`ReelClip.poster`): its long edge in pixels, and its JPEG quality. The composer
 * draws it in a 112 CSS px tile (`w-28`), 336 px at a DPR of 3, so 360 covers every phone measured;
 * at that size a 9:16 still is ~73 k pixels, about 4 % of the full photo's 1080x1920, so its
 * synchronous encode is a small fraction of a photo's (review of #1925).
 */
export const THUMBNAIL_LONG_EDGE = 360;
const THUMBNAIL_QUALITY = 0.8;

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
  /** The same crop as a small still ({@link THUMBNAIL_LONG_EDGE}), or `null` (logged). */
  thumbnail(): Blob | null;
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
  /**
   * The DIGITAL zoom the preview is enlarged by (`cameraZoom.ts`), drawn into the capture as the same
   * centred sub-rectangle. Absent or 1 for no zoom and for a HARDWARE zoom, whose frame arrives zoomed.
   */
  zoom?: number;
  /**
   * How far the capture is turned, clockwise, to come out upright (`captureTurn`): 90 or 270 make a
   * portrait preview a landscape file. Absent or 0 for no turn. A take reads it ONCE, at its start.
   */
  turn?: Quadrant;
}

/**
 * Where a take's drawing reads its frame, asked on EVERY frame: the lens can flip and the zoom move
 * during a take, so neither the element, the mirror nor the crop is fixed at its start. `null` while
 * no frame of the current lens is decoded (a flip in progress): the take then HOLDS its last frame.
 */
export type FrameSource = () => { video: HTMLVideoElement; box: PreviewBox } | null;

/** Whether a capture from `facing` is drawn flipped: exactly when the preview is (the front lens). */
export function shouldMirrorCapture(facing: 'user' | 'environment'): boolean {
  return facing === 'user';
}

/**
 * The preview's crop of `video` - `object-fit: cover`, then the digital zoom's centred part - and the
 * saved size. The size is computed from the UNZOOMED crop, so a zoom changes what is drawn, never
 * the file's dimensions (a take's canvas cannot be resized mid-file).
 */
export function cropFor(video: HTMLVideoElement, box: PreviewBox): { crop: CropRect; out: Size } {
  const cover = coverCropRect(
    { width: video.videoWidth, height: video.videoHeight },
    { width: box.width, height: box.height }
  );
  return {
    crop: digitalZoomCrop(cover, box.zoom ?? 1),
    out: framedOutputSize(box, box.dpr, cover),
  };
}

/**
 * The turn a capture of `frame` really takes. The turn ASSUMES the engine delivers the frame upright
 * for the SCREEN - a portrait frame in a portrait preview - and that the world lies on its side in
 * it. An engine that delivers the frame already turned to the DEVICE (a landscape frame in a portrait
 * preview: suspected of WebKit, unverified) would be turned twice. That case is refused at ERROR -
 * it names a broken assumption, owed an iPhone reading - and the capture keeps the frame as it came.
 * A square frame or box says nothing either way: the turn stands.
 */
export function effectiveTurn(frame: Size, box: Size, turn: Quadrant): Quadrant {
  if (turn !== 90 && turn !== 270) return turn;
  const frameLandscape = frame.width > frame.height;
  const boxLandscape = box.width > box.height;
  const squareish = frame.width === frame.height || box.width === box.height;
  if (squareish || frameLandscape === boxLandscape) return turn;
  console.error(
    `[framed-capture] the frame ${frame.width}x${frame.height} is already turned against the box ` +
      `${box.width}x${box.height}: the engine follows the device, the turn ${turn} is not applied`
  );
  return 0;
}

/** The turn {@link effectiveTurn} keeps for a capture of `video` in `box`. */
function turnFor(video: HTMLVideoElement, box: PreviewBox): Quadrant {
  return effectiveTurn(
    { width: video.videoWidth, height: video.videoHeight },
    { width: box.width, height: box.height },
    box.turn ?? 0
  );
}

/** The canvas a capture of `out` is drawn into once turned by `turn`: a quarter turn swaps the sides. */
export function turnedSize(out: Size, turn: Quadrant = 0): Size {
  return turn === 90 || turn === 270 ? { width: out.height, height: out.width } : out;
}

/**
 * The canvas transform that draws an `out`-sized picture turned `turn` degrees clockwise into its
 * {@link turnedSize} canvas: translate by (`dx`, `dy`), then rotate by `radians`.
 */
export function turnTransform(
  out: Size,
  turn: Quadrant
): { dx: number; dy: number; radians: number } {
  switch (turn) {
    case 90:
      return { dx: out.height, dy: 0, radians: Math.PI / 2 };
    case 180:
      return { dx: out.width, dy: out.height, radians: Math.PI };
    case 270:
      return { dx: 0, dy: out.width, radians: -Math.PI / 2 };
    default:
      return { dx: 0, dy: 0, radians: 0 };
  }
}

/**
 * Draws the crop into the canvas as an `out`-sized picture, flipped horizontally when `mirror` (in the
 * preview's own frame, as the preview shows it), then turned by `turn` into a {@link turnedSize}
 * canvas. The transform is undone after.
 */
export function draw(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  crop: CropRect,
  out: Size,
  mirror: boolean,
  turn: Quadrant = 0
): void {
  const plain = !mirror && turn === 0;
  if (!plain) {
    context.save();
    if (turn !== 0) {
      const { dx, dy, radians } = turnTransform(out, turn);
      context.translate(dx, dy);
      context.rotate(radians);
    }
    if (mirror) {
      context.translate(out.width, 0);
      context.scale(-1, 1);
    }
  }
  context.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, out.width, out.height);
  if (!plain) context.restore();
}

/**
 * One photo: the preview's crop of the current frame, as a JPEG.
 * Resolves `null` (logged) when the canvas cannot encode it.
 */
export function takeFramedPhoto(video: HTMLVideoElement, box: PreviewBox): Promise<Blob | null> {
  const { crop, out } = cropFor(video, box);
  const turn = turnFor(video, box);
  const file = turnedSize(out, turn);
  const canvas = document.createElement('canvas');
  canvas.width = file.width;
  canvas.height = file.height;
  const context = canvas.getContext('2d');
  if (!context) {
    console.error('[framed-capture] photo: no canvas context');
    return Promise.resolve(null);
  }
  draw(context, video, crop, out, box.mirror, turn);
  console.debug(
    `[framed-capture] photo ${file.width}x${file.height} from ${video.videoWidth}x${video.videoHeight}` +
      ` mirror=${box.mirror} turn=${turn}`
  );
  // Synchronous on purpose: `toBlob` waited ~4 s on the Android WebView (canvasBlob.ts).
  const blob = canvasToBlob(canvas, 'image/jpeg', PHOTO_QUALITY);
  if (!blob) console.error('[framed-capture] photo: the canvas produced no blob');
  return Promise.resolve(blob);
}

/** The size of a thumbnail of `out`: its long edge brought down to {@link THUMBNAIL_LONG_EDGE}. */
export function thumbnailSize(out: Size): Size {
  const scale = Math.min(1, THUMBNAIL_LONG_EDGE / Math.max(out.width, out.height));
  return { width: even(out.width * scale), height: even(out.height * scale) };
}

/**
 * The preview's crop of the current frame as a SMALL JPEG - a filmed take's thumbnail. Synchronous
 * (`canvasToBlob`, as a photo), which is why it is small, and why the capture screen takes it BEFORE
 * the recorder starts: nothing the recorder draws shares the main thread with it.
 */
export function takeFramedThumbnail(video: HTMLVideoElement, box: PreviewBox): Blob | null {
  const { crop, out } = cropFor(video, box);
  const size = thumbnailSize(out);
  const turn = turnFor(video, box);
  const file = turnedSize(size, turn);
  const canvas = document.createElement('canvas');
  canvas.width = file.width;
  canvas.height = file.height;
  const context = canvas.getContext('2d');
  if (!context) {
    console.error('[framed-capture] thumbnail: no canvas context');
    return null;
  }
  draw(context, video, crop, size, box.mirror, turn);
  const blob = canvasToBlob(canvas, 'image/jpeg', THUMBNAIL_QUALITY);
  if (!blob) console.error('[framed-capture] thumbnail: the canvas produced no blob');
  else console.debug(`[framed-capture] thumbnail ${file.width}x${file.height}, ${blob.size} bytes`);
  return blob;
}

/**
 * The preview's crop as a live stream: the video is drawn into a canvas on every display frame, and
 * the canvas's stream (plus the original audio) is what the recorder records. It is the only way to
 * record a CROP - a `MediaRecorder` has no crop of its own - and it keeps the recorded size at the
 * screen's, whatever mode the sensor picked.
 *
 * ONE RECORDER FOR THE WHOLE TAKE, WHATEVER THE LENS DOES (user, 2026-10-22: a double tap flips the
 * lens DURING a take). The recorder records the CANVAS's track and the microphone's, and neither
 * changes when the lens flips: only the element the canvas draws FROM changes, read from
 * {@link FrameSource} on every frame, with its mirror and its digital zoom. While the new lens has no
 * decoded frame the canvas re-paints its own last frame, so the file keeps a steady frame rate and
 * shows a short freeze, never a hole; the frames held are counted and logged once per flip.
 */
export class FramedStream {
  readonly stream: MediaStream;
  /** The recorded (canvas) size: the preview's crop, turned. */
  readonly size: Size;
  readonly bitrate: number;
  /** The picture's size before the turn, and the turn: both fixed for the whole take. */
  readonly #picture: Size;
  readonly #turn: Quadrant;
  #frame: number | null = null;
  #stopped = false;
  /** Frames re-painted from the canvas's own last picture since the take began (lens flips). */
  #heldTotal = 0;
  /** The current run of held frames and when it began, for its one log line. */
  #holding: { frames: number; since: number } | null = null;

  private constructor(
    source: FrameSource,
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    audio: MediaStreamTrack[],
    picture: Size,
    turn: Quadrant
  ) {
    this.size = { width: canvas.width, height: canvas.height };
    this.#picture = picture;
    this.#turn = turn;
    this.bitrate = videoBitrateFor(this.size);
    const canvasStream = canvas.captureStream(REEL_CAPTURE_FPS);
    this.stream = new MediaStream([...canvasStream.getVideoTracks(), ...audio]);
    const tick = () => {
      if (this.#stopped) return;
      this.#paint(source, canvas, context);
      this.#frame = requestAnimationFrame(tick);
    };
    this.#paint(source, canvas, context);
    this.#frame = requestAnimationFrame(tick);
    console.debug(
      `[framed-capture] take ${this.size.width}x${this.size.height} turn=${turn} at ${this.bitrate} b/s`
    );
  }

  /** Frames held so far (a lens flip's cost, in frames of the take). */
  get heldFrames(): number {
    return this.#heldTotal;
  }

  /** One frame of the take: the current lens's crop, or the last picture again while it has none. */
  #paint(source: FrameSource, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
    const now = source();
    if (now && now.video.videoWidth > 0 && now.video.videoHeight > 0) {
      if (this.#holding) {
        const ms = Math.round(performance.now() - this.#holding.since);
        console.debug(
          `[framed-capture] the new lens draws again: ${this.#holding.frames} frame(s) held over ${ms} ms`
        );
        this.#holding = null;
      }
      // The turn of the take's START, whatever the phone does after: the canvas has one size.
      draw(
        context,
        now.video,
        cropFor(now.video, now.box).crop,
        this.#picture,
        now.box.mirror,
        this.#turn
      );
      return;
    }
    // No frame of the current lens: the canvas paints its own last picture again, so the canvas
    // track keeps producing frames and the recorder never sees the video stall.
    if (!this.#holding) {
      this.#holding = { frames: 0, since: performance.now() };
      console.debug('[framed-capture] no frame from the lens: holding the last picture');
    }
    this.#holding.frames++;
    this.#heldTotal++;
    context.drawImage(canvas, 0, 0);
  }

  /**
   * @param source Where each frame is read from; it must hold a decoded frame NOW.
   * @param audio The microphone track(s) of the camera stream - they outlive a lens flip.
   * @returns `null` (logged) when there is no frame yet or no canvas to draw on.
   */
  static start(source: FrameSource, audio: MediaStreamTrack[]): FramedStream | null {
    const first = source();
    if (!first || first.video.videoWidth === 0) {
      console.error('[framed-capture] take: no decoded frame to start from');
      return null;
    }
    const { out } = cropFor(first.video, first.box);
    const turn = turnFor(first.video, first.box);
    const file = turnedSize(out, turn);
    const canvas = document.createElement('canvas');
    canvas.width = file.width;
    canvas.height = file.height;
    const context = canvas.getContext('2d');
    if (!context || typeof canvas.captureStream !== 'function') {
      console.error('[framed-capture] take: no canvas context or no canvas.captureStream');
      return null;
    }
    console.debug(
      `[framed-capture] take from ${first.video.videoWidth}x${first.video.videoHeight} ` +
        `(box ${first.box.width}x${first.box.height} @${first.box.dpr})`
    );
    return new FramedStream(source, canvas, context, audio, out, turn);
  }

  /** Stops drawing and the canvas's own track; the audio belongs to the camera session. */
  stop(): void {
    this.#stopped = true;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    for (const track of this.stream.getVideoTracks()) track.stop();
    console.debug(`[framed-capture] take stream stopped (${this.#heldTotal} frame(s) held in all)`);
  }
}
