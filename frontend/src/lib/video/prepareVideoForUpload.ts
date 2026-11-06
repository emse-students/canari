/**
 * THE ONE SEAM A VIDEO GOES THROUGH BEFORE IT IS UPLOADED (CanaReels R2, decision C3).
 *
 * Whatever the source - Android's `MediaRecorder` WebM (VP8/VP9 + Opus), iOS's MP4/MOV (H.264 or
 * HEVC + AAC), or a gallery file of either - what leaves the phone is ONE format:
 *
 * - **fragmented MP4** (`fastStart: 'fragmented'`), so the streaming reader can append it to MSE
 *   segment by segment (`segmentedMediaStream.ts`) and an old client still plays it whole;
 * - **H.264 + AAC**, the one pair both WebViews decode AND both encode in hardware (measured on the
 *   Mi 9T's WebView 152 and the iPhone 12's WKWebView, 2026-10-01). The video is always re-encoded;
 *   an AAC-LC audio track is COPIED when it costs no more than the encode would or the engine has
 *   no AAC encoder (`chooseAudioRoute`); every other track is encoded;
 * - **720p on its short side, ~2.5 Mb/s, a CONSTANT 30 fps** (a variable-rate source is resampled
 *   onto the grid), rotation baked into the frames - the numbers live in `videoEncodingPlan.ts`;
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
  VIDEO_PROFILES,
  planVideoEncoding,
  type VideoEncodingPlan,
  type VideoProfileName,
} from './videoEncodingPlan';
import {
  audioHoleMap,
  restoreAudioTimestamp,
  type AudioHoleMap,
  type AudioHoleStep,
  type DecodedChunk,
} from './audioTimeline';

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
  /**
   * Cuts the output to the VIDEO track's own span, its first frame to its last frame's end. A reel
   * loops, and audio before the first frame or past the last one is time the player holds a still
   * picture on every pass (Mi 9T, 2026-10-16: a camera take's video started 67 ms after its audio and
   * ended 71 ms before it). Left off for an attachment, whose sound past the picture is content.
   */
  trimToVideo?: boolean;
  /**
   * The encoding profile ({@link VIDEO_PROFILES}): `feed` (720p, ~2.5 Mb/s, the default) or `chat`
   * (about 540p at 1.2 Mb/s, for a reel sent in a conversation). Same container and codecs.
   */
  profile?: VideoProfileName;
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
  const {
    maxSeconds,
    maxBytes,
    onProgress,
    signal,
    removeAudio = false,
    trimToVideo = false,
    profile: profileName = 'feed',
  } = options;
  const profile = VIDEO_PROFILES[profileName];
  console.debug(
    `[video-prep] start: ${source.type || 'unknown'}, ${source.size} bytes` +
      (removeAudio ? ', audio removed' : '') +
      (trimToVideo ? ', trim to video' : '') +
      (maxSeconds !== undefined ? `, max ${maxSeconds} s` : '') +
      `, profile ${profileName}` +
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
    const trim = trimToVideo
      ? videoSpanTrim(
          await videoTrack.getFirstTimestamp(),
          await videoTrack.computeDuration(),
          durationSeconds
        )
      : null;
    if (trim) {
      console.debug(
        `[video-prep] trimmed to the video: ${trim.start.toFixed(3)}-${trim.end.toFixed(3)} s` +
          ` of ${durationSeconds.toFixed(3)} s`
      );
      durationSeconds = trim.end - trim.start;
    } else if (trimToVideo) {
      console.debug(
        `[video-prep] trim to video asked, nothing to cut: the video spans the whole` +
          ` ${durationSeconds.toFixed(3)} s`
      );
    }
    if (maxSeconds !== undefined && durationSeconds > maxSeconds + VIDEO_DURATION_GRACE_SECONDS) {
      console.warn(`[video-prep] refused: ${durationSeconds.toFixed(2)} s over ${maxSeconds} s`);
      throw new VideoPrepareError(
        'too-long',
        `video: ${durationSeconds.toFixed(2)} s is longer than ${maxSeconds} s`
      );
    }

    // An AAC-LC source is measured, and the engine asked whether it could encode AAC at the plan's
    // settings: the two facts chooseAudioRoute decides a copy on.
    const codecString =
      audioTrack && !removeAudio ? await audioTrack.getCodecParameterString() : null;
    const isAacLc = codecString?.toLowerCase() === AAC_LC_CODEC_STRING;
    const sourceAudioBitrate =
      isAacLc && audioTrack ? (await audioTrack.computePacketStats()).averageBitrate : null;
    const canEncodeAac =
      isAacLc && audioTrack
        ? await mb.canEncodeAudio('aac', {
            numberOfChannels: await audioTrack.getNumberOfChannels(),
            sampleRate: await audioTrack.getSampleRate(),
            quality: new mb.Quality({ bitrate: profile.audioBitrate }),
          })
        : null;
    // Where the source's audio really is: the decoder closes every hole in it, so the holes are read
    // from the packets BEFORE anything is converted (audioTimeline.ts).
    const holeMap = audioTrack && !removeAudio ? await readAudioHoles(mb, audioTrack) : null;
    const audioHoles = holeMap?.kind === 'map' ? holeMap.steps : [];
    const audioRoute = chooseAudioRoute({
      codecString,
      removeAudio,
      sourceBitrate: sourceAudioBitrate,
      canEncodeAac,
      audioBitrate: profile.audioBitrate,
      hasHoles: audioHoles.length > 0,
    });
    // A copied track costs what it carries, measured over every packet; an encoded one, the plan's.
    const audioBitrate =
      audioRoute === 'copy'
        ? (sourceAudioBitrate ?? 0)
        : audioRoute === 'encode'
          ? profile.audioBitrate
          : 0;
    console.debug(
      `[video-prep] audio: ${audioRoute}, ${Math.round(audioBitrate / 1000)} kb/s` +
        (canEncodeAac !== null ? `, AAC encoder ${canEncodeAac ? 'present' : 'absent'}` : '')
    );

    const plan = planVideoEncoding(
      {
        displayWidth: await videoTrack.getDisplayWidth(),
        displayHeight: await videoTrack.getDisplayHeight(),
        durationSeconds,
        audioBitrate,
      },
      maxBytes,
      profile
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
    // The source's own rate, for the log only: the output is resampled to the plan's whatever it is.
    const sourceRate = (await videoTrack.computePacketStats(120)).averagePacketRate;
    console.debug(
      `[video-prep] plan: ${describePlan(plan)}, ${durationSeconds.toFixed(2)} s,` +
        ` source ${sourceRate.toFixed(2)} fps`
    );

    // The conversion presents every sample relative to this start (mediabunny's own rule: the trim's
    // start, or the earliest timestamp of the converted tracks, never below 0); a hole map is on the
    // decoder's absolute timeline, so the restore converts between the two.
    const conversionStart =
      trim?.start ??
      Math.max(
        0,
        await input.getFirstTimestamp(
          audioTrack && audioRoute !== 'none' ? [videoTrack, audioTrack] : [videoTrack]
        )
      );
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
        // CONSTANT, whatever the source: every frame lands on the 1/30 s grid, a hole in a
        // variable-rate source is filled by holding the frame before it, and the track's timescale
        // is the rate itself. The audio keeps the source's own timeline (holes restored below).
        frameRate: plan.frameRate,
        keyFrameInterval: VIDEO_KEY_FRAME_INTERVAL,
        // Baked into the frames: a rotation left in the track header is one more thing every
        // player, MSE included, has to honour for the video to stand up.
        allowTransformationMetadata: false,
        forceTranscode: true,
      },
      audio: audioConversionOptions(mb, audioRoute, profile.audioBitrate, {
        holes: audioHoles,
        start: conversionStart,
      }),
      ...(trim ? { trim } : {}),
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
 * The trim that keeps only the video's span of a container, or null when the container already
 * starts and ends with its video (nothing to cut, so no `trim` reaches the conversion).
 *
 * @param videoStart The video track's first timestamp, in seconds (a negative one is presented from 0).
 * @param videoEnd The end of the video track's last frame, in seconds.
 * @param containerDuration The whole container's duration, every track included.
 */
export function videoSpanTrim(
  videoStart: number,
  videoEnd: number,
  containerDuration: number
): { start: number; end: number } | null {
  const start = Math.max(0, videoStart);
  const end = Math.min(videoEnd, containerDuration);
  if (end <= start) return null;
  if (start === 0 && end >= containerDuration) return null;
  return { start, end };
}

/**
 * Reads the holes of a source's audio track: every packet's timestamp (metadata only) against every
 * chunk the decoder emits for it. One decode of the audio alone - a fraction of a second for a
 * minute of AAC, against the video's encode.
 */
async function readAudioHoles(
  mb: typeof import('mediabunny'),
  track: import('mediabunny').InputAudioTrack
): Promise<AudioHoleMap> {
  const packets: number[] = [];
  for await (const p of new mb.EncodedPacketSink(track).packets(undefined, undefined, {
    metadataOnly: true,
  })) {
    packets.push(p.timestamp);
  }
  const decoded: DecodedChunk[] = [];
  for await (const s of new mb.AudioSampleSink(track).samples()) {
    decoded.push({ timestamp: s.timestamp, duration: s.duration });
    s.close();
  }
  const map = audioHoleMap(packets, decoded);
  if (map.kind === 'unpaired') {
    // The pairing the restore rests on does not hold on this engine: its holes cannot be placed, and
    // a source with holes will play its sound early. Accused, never guessed.
    console.error(
      `[video-prep] audio holes unreadable: the decoder emitted ${map.decoded} chunk(s)` +
        ` for ${map.packets} packet(s)`
    );
  } else if (map.holes > 0 || map.overlaps > 0) {
    console.warn(
      `[video-prep] the source's audio has ${map.holes} hole(s), ` +
        `${Math.round(map.holeSeconds * 1000)} ms in all, and ${map.overlaps} overlap(s):` +
        ` restored as silence`
    );
  }
  return map;
}

/** The codec string of AAC-LC, the one audio format the output carries. */
export const AAC_LC_CODEC_STRING = 'mp4a.40.2';

/** The facts the audio route is chosen on, all read from the source and the engine. */
export interface AudioRouteFacts {
  /** The source track's codec parameter string (`mp4a.40.2`, `opus`...), `null` with no track. */
  codecString: string | null;
  /** The member removed the sound. */
  removeAudio: boolean;
  /** An AAC-LC track's measured average bitrate in bits per second; `null` for any other track. */
  sourceBitrate: number | null;
  /** Whether this engine can encode AAC at the plan's settings; `null` when it was not asked. */
  canEncodeAac: boolean | null;
  /** The profile's AAC bitrate: the most a copied track may cost; defaults to {@link AUDIO_BITRATE}. */
  audioBitrate?: number;
  /**
   * The source's audio has holes (`audioHoleMap`). A copy would keep them as long samples in the
   * output, which Chrome's decoder closes again on playback: the sound after each one plays early.
   * Only an encode fills them with silence.
   */
  hasHoles?: boolean;
}

/**
 * What happens to the source's audio track - a choice made on CAPABILITY and COST, never on the
 * browser's name, and not a fallback: both routes are primary paths, each where its facts hold.
 *
 * - `none` - there is none, or the member removed the sound;
 * - `copy` - it is ALREADY AAC-LC, the output's own audio format, AND either it costs no more than
 *   the {@link AUDIO_BITRATE} an encode would ask for, or this engine has no AAC encoder at all
 *   (Firefox's WebCodecs has none). Its packets go into the MP4 as they are, no generation lost;
 * - `encode` - any other codec (the Android recorder's Opus, HE-AAC, PCM...), or an AAC-LC track
 *   dearer than {@link AUDIO_BITRATE} on an engine that CAN encode AAC: re-encoding it gives the
 *   video the budget a 320 kb/s track would otherwise take from a long clip.
 */
export function chooseAudioRoute(facts: AudioRouteFacts): 'none' | 'copy' | 'encode' {
  const { codecString, removeAudio, sourceBitrate, canEncodeAac } = facts;
  const audioBitrate = facts.audioBitrate ?? AUDIO_BITRATE;
  if (codecString === null || removeAudio) return 'none';
  if (codecString.toLowerCase() !== AAC_LC_CODEC_STRING) return 'encode';
  if (facts.hasHoles && canEncodeAac === true) return 'encode';
  if (sourceBitrate !== null && sourceBitrate <= audioBitrate) return 'copy';
  return canEncodeAac === true ? 'encode' : 'copy';
}

/**
 * The conversion's audio options for a route: `discard` (the output carries no audio track), the
 * codec ALONE for a copy - a bitrate, a sample rate, a channel count or `forceTranscode` would each
 * make mediabunny re-encode a track the output can carry as is - or AAC at the plan's bitrate.
 */
export function audioConversionOptions(
  mb: typeof import('mediabunny'),
  route: 'none' | 'copy' | 'encode',
  audioBitrate: number = AUDIO_BITRATE,
  timeline: { holes: AudioHoleStep[]; start: number } = { holes: [], start: 0 }
) {
  if (route === 'none') return { discard: true as const };
  if (route === 'copy') return { codec: 'aac' as const };
  const { holes, start } = timeline;
  return {
    codec: 'aac' as const,
    quality: new mb.Quality({ bitrate: audioBitrate }),
    forceTranscode: true,
    // Each decoded chunk moved back to where its packet says it belongs; the encoder fills the gap
    // this leaves with silence (mediabunny pads any gap of 64 samples or more).
    ...(holes.length > 0
      ? {
          process: (sample: import('mediabunny').AudioSample) => {
            const moved = sample.clone();
            moved.setTimestamp(restoreAudioTimestamp(holes, sample.timestamp + start) - start);
            return moved;
          },
        }
      : {}),
  };
}

/** The plan, as the log line prints it. */
function describePlan(plan: VideoEncodingPlan): string {
  return (
    `${plan.width}x${plan.height}, ${Math.round(plan.videoBitrate / 1000)} kb/s, ` +
    `${plan.frameRate} fps constant`
  );
}
