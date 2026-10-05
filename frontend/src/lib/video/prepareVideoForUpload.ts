/**
 * THE ONE SEAM A VIDEO GOES THROUGH BEFORE IT IS UPLOADED (CanaReels R2, decision C3).
 *
 * Whatever the source - Android's `MediaRecorder` WebM (VP8/VP9 + Opus), iOS's MP4/MOV (H.264 or
 * HEVC + AAC), or a gallery file of either - what leaves the phone is ONE format:
 *
 * - **fragmented MP4** (`fastStart: 'fragmented'`), so the streaming reader can append it to MSE
 *   segment by segment (`segmentedMediaStream.ts`) and an old client still plays it whole;
 * - **H.264 + AAC**, the one pair both WebViews decode AND both encode in hardware (measured on the
 *   Mi 9T's WebView 152 and the iPhone 12's WKWebView, 2026-10-01);
 * - **720p on its short side, ~2.5 Mb/s, at most 30 fps**, rotation baked into the frames - the
 *   numbers live in `videoEncodingPlan.ts`;
 * - and a `File` whose `type` NAMES ITS CODECS (`video/mp4; codecs="avc1...,mp4a.40.2"`), which is
 *   the fact `chooseSegmentedPlayback` reads to decide that a ref may stream.
 *
 * The work is WebCodecs (decode and encode, hardware where the engine has it) driven by mediabunny,
 * which demuxes every source container and muxes the output. NOTHING is done on the server: C3 says
 * the server stores, and a server transcoder is exactly what it refused.
 *
 * NO SECOND PATH. An engine that cannot decode the source or encode H.264/AAC is REFUSED with a
 * typed `unsupported` fault; uploading the original instead would be a second format the readers
 * then have to carry for ever. See docs/wiki/frontend/video-preparation.md for the contract and the
 * device readings.
 */

import type { Conversion, DiscardedTrack } from 'mediabunny';
import {
  AUDIO_BITRATE,
  VIDEO_KEY_FRAME_INTERVAL,
  planVideoEncoding,
  type VideoEncodingPlan,
} from './videoEncodingPlan';

/**
 * How far past `maxSeconds` a source may run and still be accepted. A recorder told to stop at 90 s
 * writes a container whose duration ends on its last frame's END, a few hundredths later; half a
 * second keeps that from refusing the very clip the camera was asked to make, and is far below
 * anything a viewer would call "longer".
 */
export const VIDEO_DURATION_GRACE_SECONDS = 0.5;

/** Why a video could not be prepared. One code per cause, so no caller ever reads the message. */
export type VideoPrepareFault =
  /** The caller's `signal` aborted it. Not a failure: nothing is shown and nothing is logged at error. */
  | 'aborted'
  /** The bytes are no container this client can read, or have no frame size. */
  | 'unreadable'
  /** A readable container with no video track in it. */
  | 'no-video-track'
  /** Longer than `maxSeconds`, or too long to fit the byte ceiling even at the lowest bitrate. */
  | 'too-long'
  /** This engine cannot decode the source's codec or encode H.264/AAC - a fact of the engine. */
  | 'unsupported'
  /** The encoder or the muxer failed while working. */
  | 'encode'
  /** The output came out over the byte ceiling despite the plan. */
  | 'too-large';

/**
 * A video that could not be prepared, classified where it was found to be so.
 *
 * The UI maps {@link VideoPrepareError.fault} to a Paraglide sentence (`videoPrepareFailureMessage`);
 * the `message` is for the console only.
 */
export class VideoPrepareError extends Error {
  constructor(
    readonly fault: VideoPrepareFault,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'VideoPrepareError';
  }
}

/** True when a rejection is a {@link VideoPrepareError}. */
export function isVideoPrepareError(err: unknown): err is VideoPrepareError {
  return err instanceof VideoPrepareError;
}

/** What a caller may bound and observe. */
export interface PrepareVideoOptions {
  /**
   * The longest source accepted, in seconds (90 for a CanaReel, decision C4). Omitted, only the byte
   * budget bounds the length.
   */
  maxSeconds?: number;
  /**
   * The plaintext ceiling the output must fit - `MediaService.uploadLimits().maxPlaintextBytes`.
   * Omitted (the server could not be asked), the C3 target bitrate is used and the server's 413
   * remains the refusal, as for every other upload.
   */
  maxBytes?: number;
  /**
   * Leaves the audio track OUT of the output (the member removed the sound, CanaReels editor). It is
   * the conversion that drops it, so the published file has no audio track at all - a muted player
   * would still ship the sound. The size budget is planned without the audio's share.
   */
  removeAudio?: boolean;
  /** Called with the share done, from 0 to 1, as frames are encoded. */
  onProgress?: (fraction: number) => void;
  /** Aborting it stops the encoder and rejects with the `aborted` fault. */
  signal?: AbortSignal;
}

/** The prepared video. */
export interface PreparedVideo {
  /** The fragmented MP4, its `type` naming its codecs. Hand it to `MediaService.encryptAndUpload`. */
  file: File;
  /** Its frame size, rotation baked in - the post's `width`/`height`. */
  width: number;
  height: number;
  /** Its duration in seconds. */
  durationSeconds: number;
  /** The source's size and the output's, for the log line and the caller's own. */
  sourceBytes: number;
  outputBytes: number;
}

/** The output's name: the source's stem, `.mp4`. */
function outputName(source: Blob): string {
  const name = source instanceof File && source.name ? source.name : 'video';
  return `${name.replace(/\.[^./\\]+$/, '') || 'video'}.mp4`;
}

/** One readable line per discarded track, for the refusal and the console. */
function describeDiscarded(discarded: DiscardedTrack[]): string {
  return discarded.map((d) => `${d.track.type} track ${d.track.id}: ${d.reason}`).join('; ');
}

/**
 * Prepares `source` for upload: reads it, re-encodes it to the one format, and returns the result.
 *
 * @param source A picked `File`, a recorder's `Blob`, a gallery video - any container the engine's
 *               demuxers know (MP4, MOV, WebM, Matroska...).
 * @throws {VideoPrepareError} for every way it can fail, each with its {@link VideoPrepareFault}.
 */
export async function prepareVideoForUpload(
  source: Blob,
  options: PrepareVideoOptions = {}
): Promise<PreparedVideo> {
  const { maxSeconds, maxBytes, onProgress, signal, removeAudio = false } = options;
  console.debug(
    `[video-prep] start: ${source.type || 'unknown'}, ${source.size} bytes` +
      (removeAudio ? ', audio removed' : '') +
      (maxSeconds !== undefined ? `, max ${maxSeconds} s` : '') +
      (maxBytes !== undefined ? `, max ${maxBytes} bytes` : '')
  );
  if (signal?.aborted) throw new VideoPrepareError('aborted', 'video preparation aborted');

  // Loaded on demand: the demuxers and muxers are only paid for by a member who picks a video.
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(source), formats: mb.ALL_FORMATS });
  let conversion: Conversion | null = null;
  const onAbort = () => {
    console.debug('[video-prep] abort requested');
    void conversion?.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const started = performance.now();
  try {
    let videoTrack;
    let audioTrack;
    let durationSeconds: number;
    try {
      videoTrack = await input.getPrimaryVideoTrack();
      audioTrack = await input.getPrimaryAudioTrack();
      durationSeconds = await input.computeDuration();
    } catch (e) {
      if (e instanceof mb.UnsupportedInputFormatError) {
        console.warn(`[video-prep] refused: ${source.type || 'unknown'} is no readable container`);
        throw new VideoPrepareError('unreadable', 'video: not a container this client reads', {
          cause: e,
        });
      }
      throw e;
    }
    if (!videoTrack) {
      console.warn('[video-prep] refused: no video track');
      throw new VideoPrepareError('no-video-track', 'video: the file has no video track');
    }
    if (maxSeconds !== undefined && durationSeconds > maxSeconds + VIDEO_DURATION_GRACE_SECONDS) {
      console.warn(`[video-prep] refused: ${durationSeconds.toFixed(2)} s over ${maxSeconds} s`);
      throw new VideoPrepareError(
        'too-long',
        `video: ${durationSeconds.toFixed(2)} s is longer than ${maxSeconds} s`
      );
    }

    const stats = await videoTrack.computePacketStats(120);
    const plan = planVideoEncoding(
      {
        displayWidth: await videoTrack.getDisplayWidth(),
        displayHeight: await videoTrack.getDisplayHeight(),
        durationSeconds,
        frameRate: stats.averagePacketRate,
        hasAudio: audioTrack !== null && !removeAudio,
      },
      maxBytes
    );
    if (plan === 'no-dimensions') {
      console.warn('[video-prep] refused: the video track reports no frame size');
      throw new VideoPrepareError('unreadable', 'video: the track has no frame size');
    }
    if (plan === 'too-long') {
      console.warn(
        `[video-prep] refused: ${durationSeconds.toFixed(1)} s cannot fit ${maxBytes} bytes`
      );
      throw new VideoPrepareError(
        'too-long',
        `video: ${durationSeconds.toFixed(1)} s cannot fit ${maxBytes} bytes at the lowest bitrate`
      );
    }
    console.debug(`[video-prep] plan: ${describePlan(plan)}, ${durationSeconds.toFixed(2)} s`);

    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: 'fragmented' }),
      target: new mb.BufferTarget(),
    });
    conversion = await mb.Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
      video: {
        codec: 'avc',
        width: plan.width,
        height: plan.height,
        fit: 'contain',
        quality: new mb.Quality({ bitrate: plan.videoBitrate, bitrateMode: 'variable' }),
        ...(plan.frameRate !== undefined ? { frameRate: plan.frameRate } : {}),
        keyFrameInterval: VIDEO_KEY_FRAME_INTERVAL,
        // Baked into the frames: a rotation left in the track header is one more thing every
        // player, MSE included, has to honour for the video to stand up.
        allowTransformationMetadata: false,
        forceTranscode: true,
      },
      audio: audioConversionOptions(mb, removeAudio),
    });
    // A dropped track is a refusal, never a quieter video: an engine that cannot decode the source
    // or encode the target says so here, as a FACT read before a frame is touched. The ONE track
    // allowed to be missing is the audio the member asked to remove, which is not a refusal.
    const refused = conversion.discardedTracks.filter(
      (d) => !(removeAudio && d.track.type === 'audio' && d.reason === 'discarded_by_user')
    );
    if (!conversion.isValid || refused.length > 0) {
      const why = describeDiscarded(refused);
      console.warn(`[video-prep] refused: this engine cannot convert it - ${why}`);
      throw new VideoPrepareError('unsupported', `video: cannot convert on this engine - ${why}`);
    }
    if (signal?.aborted) throw new VideoPrepareError('aborted', 'video preparation aborted');

    if (onProgress) conversion.onProgress = (fraction) => onProgress(fraction);
    try {
      await conversion.execute();
    } catch (e) {
      if (e instanceof mb.ConversionCanceledError || signal?.aborted) {
        throw new VideoPrepareError('aborted', 'video preparation aborted', { cause: e });
      }
      console.error('[video-prep] the encoder failed', e);
      throw new VideoPrepareError('encode', 'video: the encoder failed', { cause: e });
    }

    const buffer = output.target.buffer;
    if (!buffer) {
      console.error('[video-prep] the muxer finished with no bytes');
      throw new VideoPrepareError('encode', 'video: the muxer produced no bytes');
    }
    if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
      console.warn(`[video-prep] refused: ${buffer.byteLength} bytes over ${maxBytes}`);
      throw new VideoPrepareError(
        'too-large',
        `video: ${buffer.byteLength} bytes is over the ${maxBytes}-byte ceiling`
      );
    }
    const mimeType = await output.getMimeType();
    const file = new File([buffer], outputName(source), { type: mimeType });
    console.debug(
      `[video-prep] done in ${Math.round(performance.now() - started)} ms: ${source.size} -> ` +
        `${buffer.byteLength} bytes, ${file.type}`
    );
    return {
      file,
      width: plan.width,
      height: plan.height,
      durationSeconds,
      sourceBytes: source.size,
      outputBytes: buffer.byteLength,
    };
  } catch (e) {
    if (isVideoPrepareError(e)) {
      if (e.fault === 'aborted') console.debug('[video-prep] aborted');
      throw e;
    }
    console.error('[video-prep] failed reading the source', e);
    throw new VideoPrepareError('unreadable', 'video: the source could not be read', { cause: e });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    input.dispose();
  }
}

/**
 * What the conversion does with the audio track: AAC at the plan's bitrate, or - when the member
 * removed the sound - nothing at all (`discard`), so the output carries no audio track.
 */
export function audioConversionOptions(mb: typeof import('mediabunny'), removeAudio: boolean) {
  return removeAudio
    ? { discard: true as const }
    : {
        codec: 'aac' as const,
        quality: new mb.Quality({ bitrate: AUDIO_BITRATE }),
        forceTranscode: true,
      };
}

/** The plan, as the log line prints it. */
function describePlan(plan: VideoEncodingPlan): string {
  return (
    `${plan.width}x${plan.height}, ${Math.round(plan.videoBitrate / 1000)} kb/s` +
    (plan.frameRate !== undefined ? `, resampled to ${plan.frameRate} fps` : '')
  );
}
