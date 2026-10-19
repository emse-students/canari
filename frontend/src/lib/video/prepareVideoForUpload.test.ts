/**
 * Every way `prepareVideoForUpload` can end, each with its own fault - over a scripted mediabunny,
 * since no test engine has WebCodecs. What the real encoders do is read on the phones
 * (docs/wiki/frontend/video-preparation.md); what is pinned here is the CONTRACT a caller relies on:
 * the options reach the encoder as planned, a refusal is typed, and a dropped track is a refusal.
 */
import {
  chooseAudioRoute,
  prepareVideoForUpload,
  VideoPrepareError,
  videoSpanTrim,
} from './prepareVideoForUpload';
import { AUDIO_BITRATE, VIDEO_BUDGET_SHARE } from './videoEncodingPlan';

interface Script {
  video: boolean;
  audio: boolean;
  /** The audio track's codec parameter string (`opus` unless a test says otherwise). */
  audioCodec?: string;
  /** The audio track's measured average bitrate, bits per second. */
  audioBitrate?: number;
  /** What the engine's AAC encoder probe answers (`true` unless a test says otherwise). */
  canEncodeAac?: boolean;
  duration: number;
  /** The video track's own first timestamp and end (default 0 and `duration`). */
  videoStart?: number;
  videoEnd?: number;
  width: number;
  height: number;
  fps: number;
  unreadable?: boolean;
  discarded?: { type: string; reason: string }[];
  executeError?: Error;
  outputBytes?: number;
  /** Fires the conversion's progress at these fractions. */
  progress?: number[];
}

const state: { script: Script; init: Record<string, unknown> | null; cancelled: boolean } = {
  script: { video: true, audio: true, duration: 20, width: 1080, height: 1920, fps: 60 },
  init: null,
  cancelled: false,
};

vi.mock('mediabunny', () => {
  class UnsupportedInputFormatError extends Error {}
  class ConversionCanceledError extends Error {}
  class Input {
    disposed = false;
    async getPrimaryVideoTrack() {
      if (state.script.unreadable) throw new UnsupportedInputFormatError('nope');
      if (!state.script.video) return null;
      return {
        getDisplayWidth: async () => state.script.width,
        getDisplayHeight: async () => state.script.height,
        computePacketStats: async () => ({ averagePacketRate: state.script.fps }),
        getFirstTimestamp: async () => state.script.videoStart ?? 0,
        computeDuration: async () => state.script.videoEnd ?? state.script.duration,
      };
    }
    async getPrimaryAudioTrack() {
      if (!state.script.audio) return null;
      return {
        getCodecParameterString: async () => state.script.audioCodec ?? 'opus',
        computePacketStats: async () => ({ averageBitrate: state.script.audioBitrate ?? 96_000 }),
        getNumberOfChannels: async () => 2,
        getSampleRate: async () => 48_000,
      };
    }
    async computeDuration() {
      return state.script.duration;
    }
    dispose() {
      this.disposed = true;
    }
  }
  class Output {
    target = { buffer: null as ArrayBuffer | null };
    async getMimeType() {
      return 'video/mp4; codecs="avc1.64001f, mp4a.40.2"';
    }
  }
  return {
    ALL_FORMATS: [],
    BlobSource: class {},
    BufferTarget: class {},
    Mp4OutputFormat: class {
      constructor(readonly options: unknown) {}
    },
    Quality: class {
      constructor(readonly options: unknown) {}
    },
    Input,
    Output,
    UnsupportedInputFormatError,
    ConversionCanceledError,
    canEncodeAudio: async () => state.script.canEncodeAac ?? true,
    Conversion: {
      async init(options: Record<string, unknown> & { output: Output }) {
        state.init = options;
        const discarded = (state.script.discarded ?? []).map((d) => ({
          track: { type: d.type, id: 1 },
          reason: d.reason,
        }));
        let rejectRun: ((e: Error) => void) | null = null;
        const conversion = {
          // As the real one: a track the caller DISCARDED does not invalidate the conversion.
          isValid: discarded.every((d) => d.reason === 'discarded_by_user'),
          discardedTracks: discarded,
          onProgress: undefined as ((f: number) => void) | undefined,
          async execute() {
            for (const f of state.script.progress ?? []) conversion.onProgress?.(f);
            if (state.script.executeError) throw state.script.executeError;
            if (state.cancelled) throw new ConversionCanceledError('cancelled');
            await new Promise<void>((resolve, reject) => {
              rejectRun = reject;
              queueMicrotask(() => {
                if (state.cancelled) reject(new ConversionCanceledError('cancelled'));
                else resolve();
              });
            });
            options.output.target.buffer = new ArrayBuffer(state.script.outputBytes ?? 1000);
          },
          async cancel() {
            state.cancelled = true;
            rejectRun?.(new ConversionCanceledError('cancelled'));
          },
        };
        return conversion;
      },
    },
  };
});

const SOURCE = new File([new Uint8Array(10)], 'clip.webm', { type: 'video/webm' });

async function faultOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(VideoPrepareError);
    return (e as VideoPrepareError).fault;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  state.script = { video: true, audio: true, duration: 20, width: 1080, height: 1920, fps: 60 };
  state.init = null;
  state.cancelled = false;
});

describe('videoSpanTrim', () => {
  it('cuts the audio before the first frame and past the last one (the Mi 9T take)', () => {
    expect(videoSpanTrim(0.067, 3.449, 3.52)).toEqual({ start: 0.067, end: 3.449 });
  });

  it('cuts nothing when the container starts and ends with its video', () => {
    expect(videoSpanTrim(0, 20, 20)).toBeNull();
    expect(videoSpanTrim(-0.02, 20, 20)).toBeNull();
  });

  it('cuts nothing for a video span it cannot believe', () => {
    expect(videoSpanTrim(5, 5, 20)).toBeNull();
  });
});

describe('trimToVideo', () => {
  it('hands the video span to the conversion and returns its duration', async () => {
    state.script = { ...state.script, duration: 3.52, videoStart: 0.067, videoEnd: 3.449 };
    const out = await prepareVideoForUpload(SOURCE, { trimToVideo: true });
    expect(state.init!.trim).toEqual({ start: 0.067, end: 3.449 });
    expect(out.durationSeconds).toBeCloseTo(3.382, 6);
  });

  it('trims nothing when it is not asked (an attachment keeps its sound)', async () => {
    state.script = { ...state.script, duration: 3.52, videoStart: 0.067, videoEnd: 3.449 };
    const out = await prepareVideoForUpload(SOURCE, {});
    expect(state.init!.trim).toBeUndefined();
    expect(out.durationSeconds).toBe(3.52);
  });
});

describe('prepareVideoForUpload', () => {
  it('asks the encoder for the plan and returns a codec-naming fragmented MP4', async () => {
    const seen: number[] = [];
    state.script.progress = [0, 0.5, 1];
    const out = await prepareVideoForUpload(SOURCE, {
      maxSeconds: 90,
      maxBytes: 50 * 1024 * 1024,
      onProgress: (f) => seen.push(f),
    });
    expect(out.file.type).toBe('video/mp4; codecs="avc1.64001f, mp4a.40.2"');
    expect(out.file.name).toBe('clip.mp4');
    expect([out.width, out.height, out.durationSeconds]).toEqual([720, 1280, 20]);
    expect(seen).toEqual([0, 0.5, 1]);
    const video = state.init!.video as Record<string, unknown>;
    expect(video).toMatchObject({
      codec: 'avc',
      width: 720,
      height: 1280,
      frameRate: 30,
      keyFrameInterval: 2,
      allowTransformationMetadata: false,
      forceTranscode: true,
    });
    expect((state.init!.audio as Record<string, unknown>).codec).toBe('aac');
    expect((state.init!.output as unknown as { target: unknown }).target).toBeDefined();
  });

  it('drops the audio track from the OUTPUT when the sound is removed, and still refuses any other drop', async () => {
    state.script.discarded = [{ type: 'audio', reason: 'discarded_by_user' }];
    const out = await prepareVideoForUpload(SOURCE, { removeAudio: true });
    expect(out.file.name).toBe('clip.mp4');
    expect(state.init!.audio).toEqual({ discard: true });

    // The member did not ask for this drop: it is the engine's refusal, whatever the flag says.
    state.script.discarded = [{ type: 'video', reason: 'no_encodable_target_codec' }];
    expect(await faultOf(prepareVideoForUpload(SOURCE, { removeAudio: true }))).toBe('unsupported');
  });

  it('encodes any audio that is not AAC-LC to AAC when the sound is kept', async () => {
    await prepareVideoForUpload(SOURCE, { removeAudio: false });
    expect(state.init!.audio).toMatchObject({ codec: 'aac', forceTranscode: true });
  });

  const MAX_BYTES = 50 * 1024 * 1024;
  const videoBitrateAsked = () =>
    (state.init!.video as { quality: { options: { bitrate: number } } }).quality.options.bitrate;
  const budgetWith = (audio: number) =>
    Math.floor((MAX_BYTES * 8 * VIDEO_BUDGET_SHARE) / 200 - audio);

  it('COPIES an AAC-LC track on an engine with no AAC encoder, budgeting its own bitrate', async () => {
    // The member's 49 s AV1 + AAC-LC clip on Firefox (2026-10-13): forcing an AAC encode there
    // discarded the track as `no_encodable_target_codec` - Firefox has no AAC encoder - and the
    // whole video was refused, although the MP4 carries that AAC as it is.
    state.script.audioCodec = 'mp4a.40.2';
    state.script.audioBitrate = 320_000;
    state.script.canEncodeAac = false;
    state.script.duration = 200;
    await prepareVideoForUpload(SOURCE, { maxBytes: MAX_BYTES });
    // The codec alone: a quality, a sample rate or forceTranscode would each make it re-encode.
    expect(state.init!.audio).toEqual({ codec: 'aac' });
    expect(videoBitrateAsked()).toBe(budgetWith(320_000));
  });

  it('RE-ENCODES a dear AAC-LC track where AAC can be encoded, so the video keeps its budget', async () => {
    state.script.audioCodec = 'mp4a.40.2';
    state.script.audioBitrate = 320_000;
    state.script.canEncodeAac = true;
    state.script.duration = 200;
    await prepareVideoForUpload(SOURCE, { maxBytes: MAX_BYTES });
    expect(state.init!.audio).toMatchObject({ codec: 'aac', forceTranscode: true });
    expect(videoBitrateAsked()).toBe(budgetWith(AUDIO_BITRATE));
  });

  it('COPIES an AAC-LC track no dearer than the encode, encoder or not', async () => {
    state.script.audioCodec = 'mp4a.40.2';
    state.script.audioBitrate = 96_000;
    state.script.canEncodeAac = true;
    state.script.duration = 200;
    await prepareVideoForUpload(SOURCE, { maxBytes: MAX_BYTES });
    expect(state.init!.audio).toEqual({ codec: 'aac' });
    expect(videoBitrateAsked()).toBe(budgetWith(96_000));
  });

  it('refuses a source over maxSeconds, past the half-second grace only', async () => {
    state.script.duration = 90.4;
    await expect(prepareVideoForUpload(SOURCE, { maxSeconds: 90 })).resolves.toBeDefined();
    state.script.duration = 90.6;
    expect(await faultOf(prepareVideoForUpload(SOURCE, { maxSeconds: 90 }))).toBe('too-long');
  });

  it('refuses what cannot fit the ceiling even at the lowest bitrate', async () => {
    state.script.duration = 4 * 3600;
    expect(await faultOf(prepareVideoForUpload(SOURCE, { maxBytes: 50 * 1024 * 1024 }))).toBe(
      'too-long'
    );
  });

  it('names an unreadable container and a file with no video track', async () => {
    state.script.unreadable = true;
    expect(await faultOf(prepareVideoForUpload(SOURCE))).toBe('unreadable');
    state.script.unreadable = false;
    state.script.video = false;
    expect(await faultOf(prepareVideoForUpload(SOURCE))).toBe('no-video-track');
  });

  it('refuses a dropped track rather than shipping a quieter video', async () => {
    state.script.discarded = [{ type: 'audio', reason: 'no_encodable_target_codec' }];
    expect(await faultOf(prepareVideoForUpload(SOURCE))).toBe('unsupported');
  });

  it('types an encoder failure', async () => {
    state.script.executeError = new Error('EncodingError');
    expect(await faultOf(prepareVideoForUpload(SOURCE))).toBe('encode');
  });

  it('refuses an output over the ceiling, never cuts it', async () => {
    // A plan that fits (a hundredth of a second fits 1500 bytes at the floor), an encoder that did not.
    state.script.duration = 0.01;
    state.script.outputBytes = 2000;
    expect(await faultOf(prepareVideoForUpload(SOURCE, { maxBytes: 1500 }))).toBe('too-large');
  });

  it('stops on the signal - before it starts, and while it encodes', async () => {
    const before = new AbortController();
    before.abort();
    expect(await faultOf(prepareVideoForUpload(SOURCE, { signal: before.signal }))).toBe('aborted');

    const during = new AbortController();
    state.script.progress = [0.1];
    const run = prepareVideoForUpload(SOURCE, {
      signal: during.signal,
      onProgress: () => during.abort(),
    });
    expect(await faultOf(run)).toBe('aborted');
    expect(state.cancelled).toBe(true);
  });
});

describe('chooseAudioRoute', () => {
  const aac = (sourceBitrate: number, canEncodeAac: boolean) =>
    chooseAudioRoute({ codecString: 'mp4a.40.2', removeAudio: false, sourceBitrate, canEncodeAac });

  it('copies AAC-LC on cost or on capability, and encodes it only where both say so', () => {
    expect(aac(AUDIO_BITRATE, true)).toBe('copy');
    expect(aac(96_000, false)).toBe('copy');
    expect(aac(320_000, false)).toBe('copy');
    expect(aac(320_000, true)).toBe('encode');
    expect(
      chooseAudioRoute({
        codecString: 'MP4A.40.2',
        removeAudio: false,
        sourceBitrate: 96_000,
        canEncodeAac: true,
      })
    ).toBe('copy');
  });

  it('copies against the audio bitrate of the profile: 128 kb/s is dear for chat (96)', () => {
    const facts = { codecString: 'mp4a.40.2', removeAudio: false, canEncodeAac: true };
    expect(chooseAudioRoute({ ...facts, sourceBitrate: 128_000 })).toBe('copy');
    expect(chooseAudioRoute({ ...facts, sourceBitrate: 128_000, audioBitrate: 96_000 })).toBe(
      'encode'
    );
    expect(chooseAudioRoute({ ...facts, sourceBitrate: 96_000, audioBitrate: 96_000 })).toBe(
      'copy'
    );
  });

  it('encodes every other codec, and has no track to route when there is none', () => {
    const other = (codecString: string | null, removeAudio = false) =>
      chooseAudioRoute({ codecString, removeAudio, sourceBitrate: null, canEncodeAac: null });
    // HE-AAC is AAC too, but not the profile the output names: it is encoded to AAC-LC.
    expect(other('mp4a.40.5')).toBe('encode');
    expect(other('opus')).toBe('encode');
    expect(other('mp4a.40.2', true)).toBe('none');
    expect(other(null)).toBe('none');
  });

  it('budgets the plan AAC bitrate for an encoded track', async () => {
    state.script.duration = 200;
    const maxBytes = 50 * 1024 * 1024;
    await prepareVideoForUpload(SOURCE, { maxBytes });
    const quality = (state.init!.video as { quality: { options: { bitrate: number } } }).quality;
    expect(quality.options.bitrate).toBe(
      Math.floor((maxBytes * 8 * VIDEO_BUDGET_SHARE) / 200 - AUDIO_BITRATE)
    );
  });
});
