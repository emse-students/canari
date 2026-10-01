/**
 * Every way `prepareVideoForUpload` can end, each with its own fault - over a scripted mediabunny,
 * since no test engine has WebCodecs. What the real encoders do is read on the phones
 * (docs/wiki/frontend/video-preparation.md); what is pinned here is the CONTRACT a caller relies on:
 * the options reach the encoder as planned, a refusal is typed, and a dropped track is a refusal.
 */
import { prepareVideoForUpload, VideoPrepareError } from './prepareVideoForUpload';

interface Script {
  video: boolean;
  audio: boolean;
  duration: number;
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
      };
    }
    async getPrimaryAudioTrack() {
      return state.script.audio ? {} : null;
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
    Conversion: {
      async init(options: Record<string, unknown> & { output: Output }) {
        state.init = options;
        const discarded = (state.script.discarded ?? []).map((d) => ({
          track: { type: d.type, id: 1 },
          reason: d.reason,
        }));
        let rejectRun: ((e: Error) => void) | null = null;
        const conversion = {
          isValid: discarded.length === 0,
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
