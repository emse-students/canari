/**
 * WHAT A VIDEO IS RE-ENCODED TO BEFORE UPLOAD - the arithmetic alone, with no codec in it, so every
 * number the phone will ask its encoder for is decided (and tested) here.
 *
 * Decision C3 (user, 2026-09-29): *the PHONE compresses, the server only stores* - target 720p at
 * ~2.5 Mb/s, about 28 MB for a 90 s CanaReel, under the 50 MB ceiling. See
 * docs/wiki/frontend/video-preparation.md, the only description of the target.
 */

/** The output's SHORT side, in pixels: 720 for a 720p video whichever way the phone was held. */
export const VIDEO_MAX_SHORT_SIDE = 720;

/** The video bitrate C3 names, in bits per second. A shorter budget lowers it, never raises it. */
export const VIDEO_TARGET_BITRATE = 2_500_000;

/**
 * The lowest video bitrate a size budget may push a file down to. Below it a 720p picture is mush,
 * so a file that would need less is REFUSED as too long rather than shipped unwatchable.
 */
export const VIDEO_MIN_BITRATE = 400_000;

/** The AAC bitrate, in bits per second. */
export const AUDIO_BITRATE = 128_000;

/** Frame rates above this are resampled down to it: a 60 fps gallery clip costs twice for no reader. */
export const VIDEO_MAX_FRAME_RATE = 30;

/**
 * Seconds between key frames. Every fragment of the fragmented MP4 starts on one, so this is also
 * the granularity a seek lands on and the shortest piece the streaming reader can start from.
 */
export const VIDEO_KEY_FRAME_INTERVAL = 2;

/**
 * The share of a byte budget the encoder is ASKED for. The rest absorbs what a bitrate does not
 * count - the MP4 boxes of every fragment, and a variable-rate encoder's overshoot - so a file
 * planned under its ceiling lands under it. A file that still lands over is refused by its size
 * after the fact (`too-large`), never cut.
 */
export const VIDEO_BUDGET_SHARE = 0.9;

/** What the encoder is asked for. */
export interface VideoEncodingPlan {
  /** Output width in pixels, even (H.264 4:2:0 needs even dimensions). */
  width: number;
  /** Output height in pixels, even. */
  height: number;
  /** Video bitrate in bits per second. */
  videoBitrate: number;
  /** A frame rate to resample to, or `undefined` to keep the source's. */
  frameRate: number | undefined;
}

/** Why no plan exists for this input. */
export type VideoPlanRefusal =
  /** The source reports no usable frame size. */
  | 'no-dimensions'
  /** Even at {@link VIDEO_MIN_BITRATE} the file would not fit the byte budget. */
  | 'too-long';

/** The facts about the source a plan is computed from. */
export interface VideoSourceFacts {
  /** Width as displayed, rotation applied. */
  displayWidth: number;
  /** Height as displayed, rotation applied. */
  displayHeight: number;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Average frames per second, measured from the packets; `0` when unknown. */
  frameRate: number;
  /** Whether the output carries an audio track (its bitrate comes out of the budget). */
  hasAudio: boolean;
}

/** Rounds down to an even number, never below 2. */
function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * The output size: the source's aspect kept, the short side brought down to
 * {@link VIDEO_MAX_SHORT_SIDE} and never scaled UP, both sides even.
 */
export function outputDimensions(
  displayWidth: number,
  displayHeight: number
): { width: number; height: number } {
  const shortSide = Math.min(displayWidth, displayHeight);
  const scale = shortSide > VIDEO_MAX_SHORT_SIDE ? VIDEO_MAX_SHORT_SIDE / shortSide : 1;
  return { width: even(displayWidth * scale), height: even(displayHeight * scale) };
}

/**
 * The video bitrate that fits `maxBytes` over `durationSeconds`, capped at the C3 target - or
 * `null` when even the floor would not fit.
 *
 * @param maxBytes The plaintext ceiling (`MediaService.uploadLimits().maxPlaintextBytes`), or
 *                 `undefined` when the server could not be asked: the target is used and the
 *                 server's own 413 stays the refusal that matters, as for every other upload.
 */
export function budgetedVideoBitrate(
  durationSeconds: number,
  hasAudio: boolean,
  maxBytes: number | undefined
): number | null {
  if (maxBytes === undefined || durationSeconds <= 0) return VIDEO_TARGET_BITRATE;
  const totalBits = maxBytes * 8 * VIDEO_BUDGET_SHARE;
  const videoBits = totalBits / durationSeconds - (hasAudio ? AUDIO_BITRATE : 0);
  if (videoBits < VIDEO_MIN_BITRATE) return null;
  return Math.floor(Math.min(VIDEO_TARGET_BITRATE, videoBits));
}

/**
 * The whole plan for one source.
 *
 * @returns The plan, or the refusal naming why none exists.
 */
export function planVideoEncoding(
  facts: VideoSourceFacts,
  maxBytes: number | undefined
): VideoEncodingPlan | VideoPlanRefusal {
  if (!(facts.displayWidth > 0) || !(facts.displayHeight > 0)) return 'no-dimensions';
  const videoBitrate = budgetedVideoBitrate(facts.durationSeconds, facts.hasAudio, maxBytes);
  if (videoBitrate === null) return 'too-long';
  const { width, height } = outputDimensions(facts.displayWidth, facts.displayHeight);
  // Half a frame of slack: a 30 fps clip measures 30.02 from its timestamps and must not be touched.
  const frameRate = facts.frameRate > VIDEO_MAX_FRAME_RATE + 0.5 ? VIDEO_MAX_FRAME_RATE : undefined;
  return { width, height, videoBitrate, frameRate };
}
