import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoudnessMeter, type MediaLoudness } from '$lib/video/loudnessMeter';
import type { LoudnessTapBatch } from '$lib/workers/loudnessTap.worklet';
import {
  LOUDNESS_TAP_PROCESSOR,
  RecordingLoudness,
  tapRecordingLoudness,
  type RecordingLoudnessDeps,
} from './recordingLoudness';

const RATE = 48_000;

/** `seconds` of a 997 Hz sine at `amplitude`, as one mono plane - a voice note's stand-in. */
function sine(amplitude: number, seconds = 3): Float32Array {
  const plane = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < plane.length; i++) {
    plane[i] = amplitude * Math.sin((2 * Math.PI * 997 * i) / RATE);
  }
  return plane;
}

/** The same measurement, to the last float rounding of a different summation order. */
function expectSameMeasurement(actual: MediaLoudness | null, expected: MediaLoudness | null) {
  expect(actual).not.toBeNull();
  expect(actual!.integratedLufs).toBeCloseTo(expected!.integratedLufs, 9);
  expect(actual!.samplePeakDbfs).toBe(expected!.samplePeakDbfs);
}

/** What the measurement used to be: the whole recording through the meter at once. */
function wholeRecording(plane: Float32Array) {
  const meter = new LoudnessMeter(RATE, 1);
  meter.push([plane], plane.length);
  return meter.result();
}

/**
 * The worklet's processor, loaded as the engine loads it: the module registers its class, and the
 * test drives `process()` with the 128-frame quanta an engine hands it.
 */
async function loadTapProcessor() {
  let registered: {
    name: string;
    ctor: new () => { process(i: Float32Array[][]): boolean };
  } | null = null;
  const posted: LoudnessTapBatch[] = [];
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      port = { postMessage: (batch: LoudnessTapBatch) => posted.push(batch) };
    }
  );
  vi.stubGlobal('registerProcessor', (name: string, ctor: never) => {
    registered = { name, ctor };
  });
  vi.resetModules();
  await import('$lib/workers/loudnessTap.worklet');
  return { registered: registered!, posted };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the loudness tap - a voice note measured WHILE it is recorded', () => {
  it('a recorded stream gives the SAME measurement as the whole recording measured after', async () => {
    const { registered, posted } = await loadTapProcessor();
    expect(registered.name).toBe(LOUDNESS_TAP_PROCESSOR);
    const processor = new registered.ctor();
    const plane = sine(0.1);
    for (let at = 0; at < plane.length; at += 128) {
      expect(processor.process([[plane.subarray(at, at + 128)]])).toBe(true);
    }
    const measured = new RecordingLoudness(RATE);
    for (const batch of posted) measured.accept(batch);
    // 3 s at 48 kHz is 70.3 batches of 2048: the 0.3 left in the worklet is the tail a stop drops,
    // so the reference is the same frames.
    const reference = wholeRecording(plane.subarray(0, measured.frames));
    expect(measured.frames).toBe(70 * 2048);
    expectSameMeasurement(measured.result(), reference);
    // BS.1770: a mono 997 Hz sine at -20 dBFS is -23.01 LUFS.
    expect(measured.result()!.integratedLufs).toBeCloseTo(-23.01, 1);
    expect(measured.result()!.samplePeakDbfs).toBeCloseTo(-20, 1);
  });

  it('measures silence as nothing - the note is sent unmeasured', () => {
    const measured = new RecordingLoudness(RATE);
    const silence = new Float32Array(RATE * 2);
    measured.accept({ planes: [silence], frames: silence.length });
    expect(measured.result()).toBeNull();
  });
});

/** A context reduced to what the tap calls. */
function fakeDeps(options: { moduleFails?: boolean } = {}) {
  const ports: { onmessage: ((e: MessageEvent<LoudnessTapBatch>) => void) | null }[] = [];
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = { onmessage: null };
      constructor(_ctx: unknown, name: string) {
        expect(name).toBe(LOUDNESS_TAP_PROCESSOR);
        ports.push(this.port);
      }
      connect = vi.fn();
      disconnect = vi.fn();
    }
  );
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const context = {
    sampleRate: RATE,
    currentTime: 0,
    state: 'running',
    audioWorklet: {
      addModule: vi.fn(() =>
        options.moduleFails ? Promise.reject(new Error('blocked')) : Promise.resolve()
      ),
    },
    createMediaStreamSource: vi.fn(node),
    createMediaStreamDestination: vi.fn(node),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const deps: RecordingLoudnessDeps = {
    createContext: () => context as unknown as AudioContext,
    workletUrl: 'blob:tap',
  };
  return { deps, context, ports };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('tapRecordingLoudness', () => {
  it('feeds what the worklet posts, and its stop returns the measurement and closes the context', async () => {
    const { deps, context, ports } = fakeDeps();
    const tap = tapRecordingLoudness({} as MediaStream, deps);
    await flush();
    expect(ports).toHaveLength(1);
    const plane = sine(0.1, 2);
    for (let at = 0; at < plane.length; at += 2048) {
      const planes = [plane.slice(at, at + 2048)];
      ports[0].onmessage!({ data: { planes, frames: planes[0].length } } as never);
    }
    const loudness = tap.stop();
    expectSameMeasurement(loudness, wholeRecording(plane));
    expect(context.close).toHaveBeenCalledOnce();
    // Idempotent: the recorder's release stops it again.
    expect(tap.stop()).toBeNull();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('sends unmeasured, and says why, when the module does not load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, context } = fakeDeps({ moduleFails: true });
    const tap = tapRecordingLoudness({} as MediaStream, deps);
    await flush();
    expect(tap.stop()).toBeNull();
    expect(context.close).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('did not load');
  });

  it('sends unmeasured where the engine has no AudioWorklet, and makes no context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('AudioWorkletNode', undefined);
    const createContext = vi.fn();
    const tap = tapRecordingLoudness({} as MediaStream, { createContext, workletUrl: 'x' });
    expect(tap.stop()).toBeNull();
    expect(createContext).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
