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
  /** The audio packets' timestamps, and what the decoder stamps its chunks (default: contiguous). */
  audioPackets?: number[];
  decodedChunks?: { timestamp: number; duration: number }[];
  /** The audio decoder throws (an engine with none, a corrupt packet). */
  decoderThrows?: boolean;
}

const FRAME = 1024 / 48_000;
const contiguous = (n: number) => Array.from({ length: n }, (_, i) => i * FRAME);

const state: {
  script: Script;
  init: Record<string, unknown> | null;
  cancelled: boolean;
  /** Every window the audio was decoded over, before the conversion. */
  decodes: [number, number | undefined][];
} = {
  script: { video: true, audio: true, duration: 20, width: 1080, height: 1920, fps: 60 },
  init: null,
  cancelled: false,
  decodes: [],
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
    async getFirstTimestamp() {
      return 0;
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
    EncodedPacketSink: class {
      async *packets() {
        for (const timestamp of state.script.audioPackets ?? contiguous(3)) yield { timestamp };
      }
    },
    AudioSampleSink: class {
      async *samples(start: number, end?: number) {
        state.decodes.push([start, end]);
        if (state.script.decoderThrows) throw new Error('no decoder for mp4a.40.2');
        const chunks =
          state.script.decodedChunks ??
          contiguous(3).map((timestamp) => ({ timestamp, duration: FRAME }));
        // Like mediabunny: the window is cut on the decoder's own (collapsed) timeline.
        for (const c of chunks) {
          if (c.timestamp + c.duration <= start) continue;
          if (end !== undefined && c.timestamp >= end) break;
          yield { ...c, close() {} };
        }
      }
    },
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
  state.decodes = [];
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

  it.each([24, 23.88, 30.02])(
    'resamples a %s fps source (a 24 fps clip, a phone that dropped frames, 30 measured) to a constant 30',
    async (fps) => {
      // Until 2026-11-06 only a source over 30.5 fps was resampled, so a variable-rate one kept
      // its irregular timestamps and its quarter-second holes (video-preparation.md#constant-frame-rate-and-the-audio-holes-the-decoder-closes).
      state.script.fps = fps;
      await prepareVideoForUpload(SOURCE, {});
      expect((state.init!.video as Record<string, unknown>).frameRate).toBe(30);
    }
  );

  describe('holes in the source audio (2026-11-06, a sound that ran ahead of its picture)', () => {
    // A recorder lost 10 packets after the 3rd: the packets say so, Chrome's decoder does not.
    const HOLE = 10 * FRAME;
    const holed = {
      audioCodec: 'mp4a.40.2',
      audioBitrate: 96_000,
      audioPackets: [0, FRAME, 2 * FRAME, 3 * FRAME + HOLE, 4 * FRAME + HOLE],
      decodedChunks: contiguous(5).map((timestamp) => ({ timestamp, duration: FRAME })),
    };
    /** A decoded chunk as mediabunny hands the hook: cloned or trimmed, then re-stamped. */
    const chunkAt = (timestamp: number, numberOfFrames = 1024) => {
      const make = (frames: number) => {
        const out = {
          timestamp,
          numberOfFrames: frames,
          setTimestamp(t: number) {
            out.timestamp = t;
          },
        };
        return out;
      };
      return {
        timestamp,
        numberOfFrames,
        sampleRate: 48_000,
        clone: () => make(numberOfFrames),
        trim: (_from: number, to: number) => make(to),
      };
    };
    type Hook = (s: unknown) => { timestamp: number; numberOfFrames: number } | null;
    const hook = () => (state.init!.audio as { process?: Hook }).process;

    it('moves each chunk back over its hole, and encodes rather than copies the track', async () => {
      state.script = { ...state.script, ...holed };
      await prepareVideoForUpload(SOURCE, {});
      expect(state.init!.audio).toMatchObject({ forceTranscode: true });
      expect(hook()!(chunkAt(2 * FRAME))!.timestamp).toBeCloseTo(2 * FRAME, 9);
      expect(hook()!(chunkAt(4 * FRAME))!.timestamp).toBeCloseTo(4 * FRAME + HOLE, 9);
    });

    it('never decodes a track without holes: it is copied as before', async () => {
      state.script = { ...state.script, audioCodec: 'mp4a.40.2', audioBitrate: 96_000 };
      await prepareVideoForUpload(SOURCE, {});
      expect(state.init!.audio).toEqual({ codec: 'aac' });
      expect(state.decodes).toEqual([]);
    });

    it('keeps the old route and never refuses the upload when the decoder fails', async () => {
      state.script = { ...state.script, ...holed, decoderThrows: true };
      const warn = vi.spyOn(console, 'warn');
      const out = await prepareVideoForUpload(SOURCE, {});
      expect(out.file.name).toBe('clip.mp4');
      expect(state.init!.audio).toEqual({ codec: 'aac' });
      expect(warn.mock.calls.flat().join('\n')).toContain(
        'audio holes NOT restored (the decoder failed: no decoder for mp4a.40.2): copied with its' +
          ' holes: the sound after each hole plays early on Chrome'
      );
      warn.mockRestore();
    });

    it('names the consequence when no AAC encoder can restore the holes, and decodes nothing', async () => {
      state.script = { ...state.script, ...holed, canEncodeAac: false };
      const warn = vi.spyOn(console, 'warn');
      await prepareVideoForUpload(SOURCE, {});
      expect(state.init!.audio).toEqual({ codec: 'aac' });
      expect(state.decodes).toEqual([]);
      expect(warn.mock.calls.flat().join('\n')).toContain(
        'audio holes NOT restored (no AAC encoder): copied with its holes: the sound after each' +
          ' hole plays early on Chrome'
      );
      warn.mockRestore();
    });

    it('names an unpaired decoder in ONE error line with the counts, and keeps the old route', async () => {
      state.script = { ...state.script, ...holed, decodedChunks: holed.decodedChunks.slice(0, 4) };
      const error = vi.spyOn(console, 'error');
      await prepareVideoForUpload(SOURCE, {});
      expect(state.init!.audio).toEqual({ codec: 'aac' });
      expect(error.mock.calls).toHaveLength(1);
      expect(String(error.mock.calls[0][0])).toContain('4 chunk(s) for 5 packet(s)');
      expect(String(error.mock.calls[0][0])).toContain('the sound after each hole plays early');
      error.mockRestore();
    });

    describe('a reel trimmed to its video, with a hole inside the window', () => {
      // 40 packets, 10 lost after the 10th: the sound really runs to 50 frames, the decoder says 40.
      // The window ends at 30 frames on the REAL timeline; the decoder would cut its own timeline
      // there (30 chunks) while the packets before it are 20 - so the pre-pass decodes to the end.
      const trimmed = (endFrames: number) => {
        const packets = contiguous(40).map((t, i) => (i < 10 ? t : t + 10 * FRAME));
        state.script = {
          ...state.script,
          ...holed,
          audioPackets: packets,
          decodedChunks: contiguous(40).map((timestamp) => ({ timestamp, duration: FRAME })),
          duration: 50 * FRAME,
          videoStart: 0,
          videoEnd: endFrames * FRAME,
        };
        return prepareVideoForUpload(SOURCE, { trimToVideo: true });
      };

      it('says the first chunk matched no packet, not that the packets were zero', async () => {
        state.script = {
          ...state.script,
          ...holed,
          decodedChunks: contiguous(5).map((t) => ({ timestamp: t + FRAME / 2, duration: FRAME })),
        };
        const error = vi.spyOn(console, 'error');
        await prepareVideoForUpload(SOURCE, {});
        expect(state.init!.audio).toEqual({ codec: 'aac' });
        expect(error.mock.calls).toHaveLength(1);
        const line = String(error.mock.calls[0][0]);
        expect(line).toContain('the first chunk at 0.011 s matches no packet');
        expect(line).not.toContain('packet(s)');
        error.mockRestore();
      });

      it('decodes from the start to the end of the track and restores the holes', async () => {
        const error = vi.spyOn(console, 'error');
        await trimmed(30);
        expect(error).not.toHaveBeenCalled();
        error.mockRestore();
        expect(state.decodes).toEqual([[0, undefined]]);
        expect(state.init!.audio).toMatchObject({ forceTranscode: true });
        expect(hook()!(chunkAt(9 * FRAME))!.timestamp).toBeCloseTo(9 * FRAME, 9);
        expect(hook()!(chunkAt(12 * FRAME))!.timestamp).toBeCloseTo(22 * FRAME, 9);
        // Restored past the window's end: dropped, though the decoder stamped it before.
        expect(hook()!(chunkAt(20 * FRAME))).toBeNull();
      });

      it('cuts the chunk that overhangs the window to the window', async () => {
        await trimmed(29.5);
        const last = hook()!(chunkAt(19 * FRAME))!;
        expect(last.timestamp).toBeCloseTo(29 * FRAME, 9);
        expect(last.numberOfFrames).toBe(512);
      });

      it('drops a chunk with less than one sample left before the end (no empty AudioData)', async () => {
        await trimmed(29 + 0.4 / 1024);
        expect(hook()!(chunkAt(19 * FRAME))).toBeNull();
      });
    });

    it('stops reading the packets when the member cancels', async () => {
      state.script = { ...state.script, ...holed };
      const controller = new AbortController();
      const reading = prepareVideoForUpload(SOURCE, { signal: controller.signal });
      controller.abort();
      expect(await faultOf(reading)).toBe('aborted');
    });
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
