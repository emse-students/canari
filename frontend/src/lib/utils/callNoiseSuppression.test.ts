/**
 * The call microphone's noise suppression (owner decision D-B, 2026-10-31): the pipeline builder,
 * on and off, its failures (a typed cause, never a throw, never a failed call), and the per-call
 * switch that moves the SAME sender between the raw and the processed track with `replaceTrack`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCallAudioConstraints } from './callAudio';
import {
  buildCallMicPipeline,
  CALL_NOISE_SUPPRESSION_DEFAULT,
  CALL_NOISE_SUPPRESSOR_PROCESSOR,
  CallMicSwitch,
  describeNoiseSuppressionCost,
  initialNoiseSuppressionView,
  micTrackToSend,
  noiseSuppressionUnsupported,
  type CallMicPipeline,
  type CallMicPipelineDeps,
  type CallMicPipelineResult,
} from './callNoiseSuppression';

type Listener = ((e: { data: unknown }) => void) | null;

/** The worklet nodes the fake engine built, so a test can speak for the processor. */
const nodes: FakeNode[] = [];

class FakeNode {
  readonly port = {
    onmessage: null as Listener,
    postMessage: vi.fn(),
  };
  onprocessorerror: ((e: Event) => void) | null = null;
  readonly connect = vi.fn((next: unknown) => next);
  readonly disconnect = vi.fn();
  constructor(
    readonly ctx: FakeContext,
    readonly name: string,
    readonly options: { processorOptions: { wasm: ArrayBuffer } }
  ) {
    nodes.push(this);
  }
  /** The processor's `ready` (or any message) arriving on the page's side of the port. */
  say(data: unknown) {
    this.port.onmessage?.({ data });
  }
}

const track = (id: string) => ({ id, kind: 'audio', stop: vi.fn() }) as unknown as MediaStreamTrack;

class FakeContext {
  state: AudioContextState = 'running';
  onstatechange: (() => void) | null = null;
  readonly processed = track('processed');
  readonly audioWorklet = { addModule: vi.fn(async (_url: string) => {}) };
  readonly close = vi.fn(async () => {});
  readonly resume = vi.fn(async () => {});
  constructor(readonly sampleRate = 48_000) {}
  createMediaStreamSource() {
    return { connect: vi.fn((next: unknown) => next), disconnect: vi.fn() };
  }
  createMediaStreamDestination() {
    return { channelCount: 2, stream: { getAudioTracks: () => [this.processed] } };
  }
  /** The engine suspending (or resuming) the context mid-call. */
  become(state: AudioContextState) {
    this.state = state;
    this.onstatechange?.();
  }
}

function engine() {
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  vi.stubGlobal('MediaStreamAudioDestinationNode', class {});
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: MediaStreamTrack[]) {}
    }
  );
}

function deps(ctx: FakeContext, overrides: Partial<CallMicPipelineDeps> = {}) {
  const logs: string[] = [];
  const d: CallMicPipelineDeps = {
    createContext: () => ctx as unknown as AudioContext,
    workletUrl: '/rnnoise.worklet.js',
    loadWasm: async () => new ArrayBuffer(8),
    log: (l) => logs.push(l),
    ...overrides,
  };
  return { d, logs };
}

/** Lets the builder reach the point where it waits for the processor's `ready`. */
async function untilNodeBuilt() {
  for (let i = 0; i < 20 && nodes.length === 0; i++) await Promise.resolve();
  expect(nodes.length).toBe(1);
  return nodes[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
  nodes.length = 0;
});

describe('buildCallMicPipeline', () => {
  it('builds source -> RNNoise worklet -> destination at 48 kHz, and waits for the PROOF it processes', async () => {
    engine();
    const ctx = new FakeContext();
    const { d } = deps(ctx);
    const raw = track('raw');
    let settled = false;
    const building = buildCallMicPipeline(raw, d).then((r) => {
      settled = true;
      return r;
    });
    const node = await untilNodeBuilt();
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith('/rnnoise.worklet.js');
    expect(node.name).toBe(CALL_NOISE_SUPPRESSOR_PROCESSOR);
    expect(node.options.processorOptions.wasm).toBeInstanceOf(ArrayBuffer);
    // No `ready` yet: no clock decides for the worklet.
    await Promise.resolve();
    expect(settled).toBe(false);

    node.say({ type: 'ready', clock: 'performance' });
    const result = await building;
    expect(result.ok).toBe(true);
    const pipeline = (result as { pipeline: CallMicPipeline }).pipeline;
    expect(pipeline.processed).toBe(ctx.processed);
    expect(pipeline.usable()).toBe(true);
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('is not usable while the engine holds its context suspended', async () => {
    engine();
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    const building = buildCallMicPipeline(track('raw'), deps(ctx).d);
    (await untilNodeBuilt()).say({ type: 'ready', clock: 'date' });
    const result = await building;
    const pipeline = (result as { pipeline: CallMicPipeline }).pipeline;
    expect(pipeline.usable()).toBe(false);
    ctx.become('running');
    expect(pipeline.usable()).toBe(true);
  });

  it('returns the cause, never throws, when the worklet module does not load', async () => {
    engine();
    const ctx = new FakeContext();
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error('AbortError: module failed'));
    const result = await buildCallMicPipeline(track('raw'), deps(ctx).d);
    expect(result).toEqual({
      ok: false,
      failure: 'worklet-module',
      detail: 'Error: AbortError: module failed',
    });
    expect(ctx.close).toHaveBeenCalled();
  });

  it('returns the cause when the worklet scope cannot run the wasm (its `error` message)', async () => {
    engine();
    const ctx = new FakeContext();
    const building = buildCallMicPipeline(track('raw'), deps(ctx).d);
    (await untilNodeBuilt()).say({
      type: 'error',
      detail: 'this AudioWorklet scope has no WebAssembly',
    });
    expect(await building).toEqual({
      ok: false,
      failure: 'worklet-init',
      detail: 'this AudioWorklet scope has no WebAssembly',
    });
  });

  it('returns the cause when the wasm cannot be fetched', async () => {
    engine();
    const ctx = new FakeContext();
    const result = await buildCallMicPipeline(
      track('raw'),
      deps(ctx, {
        loadWasm: async () => Promise.reject(new Error('GET rnnoise.wasm answered 404')),
      }).d
    );
    expect(result).toMatchObject({ ok: false, failure: 'wasm-fetch' });
  });

  it('names an engine that refuses the AudioContext itself', async () => {
    engine();
    const result = await buildCallMicPipeline(
      track('raw'),
      deps(new FakeContext(), {
        createContext: () => {
          throw new Error('NotSupportedError: sampleRate');
        },
      }).d
    );
    expect(result).toEqual({
      ok: false,
      failure: 'context',
      detail: 'Error: NotSupportedError: sampleRate',
    });
  });

  it('refuses a context that does not run at 48 kHz (RNNoise frames are 480 samples of 10 ms)', async () => {
    engine();
    const ctx = new FakeContext(44_100);
    const result = await buildCallMicPipeline(track('raw'), deps(ctx).d);
    expect(result).toMatchObject({ ok: false, failure: 'sample-rate' });
  });

  it('names the missing feature on an engine without AudioWorklet, before making any context', async () => {
    const createContext = vi.fn();
    const result = await buildCallMicPipeline(
      track('raw'),
      deps(new FakeContext(), { createContext }).d
    );
    expect(result).toMatchObject({ ok: false, failure: 'no-audio-worklet' });
    expect(createContext).not.toHaveBeenCalled();
    expect(noiseSuppressionUnsupported({ AudioWorkletNode: class {} })).toBe(
      'no-media-stream-destination'
    );
  });
});

describe('micTrackToSend', () => {
  const raw = track('raw');
  const processed = track('processed');
  const pipeline = (usable: boolean) => ({ processed, usable: () => usable }) as CallMicPipeline;

  it('sends the processed track only when on AND the pipeline proved it runs', () => {
    expect(micTrackToSend(raw, pipeline(true), true)).toBe(processed);
    expect(micTrackToSend(raw, pipeline(false), true)).toBe(raw);
    expect(micTrackToSend(raw, pipeline(true), false)).toBe(raw);
    expect(micTrackToSend(raw, null, true)).toBe(raw);
  });
});

/** A sender as the call holds it: `replaceTrack` changes its track, never the sender. */
function fakeSender(initial: MediaStreamTrack) {
  const sender = {
    track: initial,
    transform: { the: 'E2E transform' },
    replaceTrack: vi.fn(async (next: MediaStreamTrack) => {
      sender.track = next;
    }),
  };
  return sender;
}

function fakePipeline(processed: MediaStreamTrack) {
  let usable = true;
  let onChange: () => void = () => {};
  const pipeline: CallMicPipeline = {
    processed,
    usable: () => usable,
    contextState: () => (usable ? 'running' : 'suspended'),
    stats: () => ({ frames: 1000, busyMs: 450, maxQuantumMs: 0.9, clock: 'performance' }),
    onUsableChange: (l) => (onChange = l),
    close: vi.fn(),
  };
  return {
    pipeline,
    setUsable(next: boolean) {
      usable = next;
      onChange();
    },
  };
}

describe('CallMicSwitch - the per-call switch', () => {
  const ok = (pipeline: CallMicPipeline): CallMicPipelineResult => ({ ok: true, pipeline });

  it('ships OFF (owner, 2026-11-01): a call starts raw, reports ns=off and builds nothing', () => {
    expect(CALL_NOISE_SUPPRESSION_DEFAULT).toBe(false);
    expect(initialNoiseSuppressionView()).toEqual({ enabled: false, state: 'off' });
    const raw = track('raw');
    const sw = new CallMicSwitch(
      raw,
      CALL_NOISE_SUPPRESSION_DEFAULT,
      () => {},
      () => {}
    );
    const build = vi.fn(async (): Promise<CallMicPipelineResult> => ({
      ok: true,
      pipeline: fakePipeline(track('processed')).pipeline,
    }));
    sw.ensurePipeline(build);
    expect(build).not.toHaveBeenCalled();
    expect(sw.trackToSend()).toBe(raw);
    expect(sw.reportState()).toBe('off');
  });

  it('builds the pipeline on the first ON of the call, once, and then sends it', async () => {
    const raw = track('raw');
    const sw = new CallMicSwitch(
      raw,
      false,
      () => {},
      () => {}
    );
    const sender = fakeSender(sw.trackToSend());
    sw.attachSender(sender as unknown as RTCRtpSender);
    const { pipeline } = fakePipeline(track('processed'));
    let settle: (r: CallMicPipelineResult) => void = () => {};
    const build = vi.fn(() => new Promise<CallMicPipelineResult>((resolve) => (settle = resolve)));

    sw.setEnabled(true);
    sw.ensurePipeline(build);
    expect(sw.reportState()).toBe('pending');
    sw.setEnabled(false);
    sw.setEnabled(true);
    sw.ensurePipeline(build);
    expect(build).toHaveBeenCalledTimes(1);

    settle(ok(pipeline));
    await vi.waitFor(() => expect(sw.reportState()).toBe('on'));
    await sw.settled();
    expect(sender.track).toBe(pipeline.processed);
    sw.ensurePipeline(build);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('switched ON, moves the SAME sender to the processed track once ready, and keeps its transform', async () => {
    const raw = track('raw');
    const logs: string[] = [];
    const views: unknown[] = [];
    const sw = new CallMicSwitch(
      raw,
      true,
      (l) => logs.push(l),
      (v) => views.push(v)
    );
    const sender = fakeSender(sw.trackToSend());
    expect(sender.track).toBe(raw);
    sw.attachSender(sender as unknown as RTCRtpSender);

    const { pipeline } = fakePipeline(track('processed'));
    sw.adopt(ok(pipeline));
    await sw.settled();
    expect(sender.replaceTrack).toHaveBeenCalledWith(pipeline.processed);
    expect(sender.track).toBe(pipeline.processed);
    expect(sender.transform).toEqual({ the: 'E2E transform' });
    expect(sw.reportState()).toBe('on');
    expect(views.at(-1)).toEqual({ enabled: true, state: 'on' });
  });

  it('OFF sends the raw track and ON the processed one again, with no renegotiation', async () => {
    const raw = track('raw');
    const sw = new CallMicSwitch(
      raw,
      true,
      () => {},
      () => {}
    );
    const { pipeline } = fakePipeline(track('processed'));
    sw.adopt(ok(pipeline));
    // A sender made after the pipeline: it starts on the processed track.
    const sender = fakeSender(sw.trackToSend());
    expect(sender.track).toBe(pipeline.processed);
    sw.attachSender(sender as unknown as RTCRtpSender);

    sw.setEnabled(false);
    await sw.settled();
    expect(sender.track).toBe(raw);
    expect(sw.reportState()).toBe('off');

    sw.setEnabled(true);
    await sw.settled();
    expect(sender.track).toBe(pipeline.processed);
    expect(sender.replaceTrack).toHaveBeenCalledTimes(2);
    expect(sw.fallbackCount()).toBe(0);
  });

  it('a failed build is a WARN with its cause and a counted fallback, and the call keeps the raw track', async () => {
    const raw = track('raw');
    const logs: string[] = [];
    const sw = new CallMicSwitch(
      raw,
      true,
      (l) => logs.push(l),
      () => {}
    );
    const sender = fakeSender(sw.trackToSend());
    sw.attachSender(sender as unknown as RTCRtpSender);
    sw.adopt({
      ok: false,
      failure: 'worklet-init',
      detail: 'this AudioWorklet scope has no WebAssembly',
    });
    await sw.settled();
    expect(sender.track).toBe(raw);
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(sw.reportState()).toBe('unavailable');
    expect(sw.fallbackCount()).toBe(1);
    expect(logs).toContain(
      '[Call] WARN noise suppression unavailable (worklet-init: this AudioWorklet scope has no WebAssembly) - the raw microphone is sent'
    );
  });

  it('a processed path that stops carrying (context suspended) goes back to raw, loudly, and returns when it runs', async () => {
    const raw = track('raw');
    const logs: string[] = [];
    const sw = new CallMicSwitch(
      raw,
      true,
      (l) => logs.push(l),
      () => {}
    );
    const sender = fakeSender(raw);
    sw.attachSender(sender as unknown as RTCRtpSender);
    const fake = fakePipeline(track('processed'));
    sw.adopt(ok(fake.pipeline));
    await sw.settled();
    expect(sender.track).toBe(fake.pipeline.processed);

    fake.setUsable(false);
    await sw.settled();
    expect(sender.track).toBe(raw);
    expect(sw.fallbackCount()).toBe(1);
    expect(sw.reportState()).toBe('pending');
    expect(logs.some((l) => l.startsWith('[Call] WARN noise suppression stopped carrying'))).toBe(
      true
    );

    fake.setUsable(true);
    await sw.settled();
    expect(sender.track).toBe(fake.pipeline.processed);
  });

  it('a refused replaceTrack is counted and logged, and the next decision still runs', async () => {
    const raw = track('raw');
    const logs: string[] = [];
    const sw = new CallMicSwitch(
      raw,
      true,
      (l) => logs.push(l),
      () => {}
    );
    const sender = fakeSender(raw);
    sender.replaceTrack.mockRejectedValueOnce(new Error('InvalidStateError'));
    sw.attachSender(sender as unknown as RTCRtpSender);
    const { pipeline } = fakePipeline(track('processed'));
    sw.adopt(ok(pipeline));
    await sw.settled();
    expect(sw.fallbackCount()).toBe(1);
    expect(logs.some((l) => l.includes('WARN microphone replaceTrack(processed) refused'))).toBe(
      true
    );
    sw.setEnabled(false);
    sw.setEnabled(true);
    await sw.settled();
    expect(sender.track).toBe(pipeline.processed);
  });

  it('logs the cost ONCE at the end, and releases a pipeline that settles after the call', async () => {
    const logs: string[] = [];
    const sw = new CallMicSwitch(
      track('raw'),
      true,
      (l) => logs.push(l),
      () => {}
    );
    const fake = fakePipeline(track('processed'));
    sw.adopt(ok(fake.pipeline));
    sw.close();
    sw.close();
    const costLines = logs.filter((l) => l.startsWith('[Call] noise suppression end:'));
    expect(costLines).toEqual([
      '[Call] noise suppression end: ns=on ns_fallbacks=0 frames=1000 cost_ms_per_frame=0.450 realtime_pct=4.5 max_quantum_ms=0.90 clock=performance',
    ]);
    expect(fake.pipeline.close).toHaveBeenCalledTimes(1);

    const late = fakePipeline(track('late'));
    sw.adopt(ok(late.pipeline));
    expect(late.pipeline.close).toHaveBeenCalledTimes(1);
  });
});

describe('describeNoiseSuppressionCost', () => {
  it('says there is no number rather than inventing one', () => {
    expect(describeNoiseSuppressionCost('unavailable', null, 1)).toBe(
      '[Call] noise suppression end: ns=unavailable ns_fallbacks=1 frames=0 cost=- (no stats from the worklet)'
    );
  });
});

describe('the capture the suppressor works on', () => {
  it("keeps the browser's echo canceller ON: RNNoise comes AFTER AEC, never instead of it", () => {
    const c = buildCallAudioConstraints();
    expect(c.echoCancellation).toEqual({ ideal: true });
    expect(c.googEchoCancellation).toEqual({ ideal: true });
    expect(c.sampleRate).toEqual({ ideal: 48_000 });
  });
});
