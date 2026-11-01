/**
 * THE CALL MICROPHONE'S NOISE SUPPRESSION (owner decision D-B, 2026-10-31): RNNoise on the captured
 * track, with a per-call switch - OFF by default since 2026-11-01 (`CALL_NOISE_SUPPRESSION_DEFAULT`).
 *
 * The pipeline is `raw capture -> MediaStreamSource -> AudioWorkletNode (workers/rnnoise.worklet.ts)
 * -> MediaStreamDestination`, in a 48 kHz `AudioContext`. The raw capture keeps the browser's echo
 * canceller (`buildCallAudioConstraints`), so RNNoise works on what AEC already cleaned.
 *
 * WHICH TRACK THE CALL SENDS is decided by {@link micTrackToSend} alone, and changed on the SAME
 * sender with `replaceTrack` - no renegotiation, and the sender's E2E transform stays where it was
 * (it belongs to the sender, never to a track). The processed track is sent only once the worklet
 * has PROVEN it processes (`ready` after its first quantum) and while its context RUNS: a context
 * the engine suspended renders nothing, and sending its output would send silence.
 *
 * THE PRIMARY PATH FAILING IS A SIGNAL, NEVER A PATH: no AudioWorklet, no WebAssembly in the
 * worklet scope, a wasm that does not load, a context not at 48 kHz - each is returned as a typed
 * failure, which the call logs at WARN with its cause and counts in `[CALL_REPORT] ns_fallbacks=`,
 * and the call goes on with the raw track. It never fails a call.
 */

/** The processor name `workers/rnnoise.worklet.ts` registers. */
export const CALL_NOISE_SUPPRESSOR_PROCESSOR = 'canari-rnnoise';

/** RNNoise's frame: 10 ms at 48 kHz. */
export const RNNOISE_FRAME_SAMPLES = 480;

/**
 * Where every call's switch starts: OFF (owner, 2026-11-01). Built ON (D-B, 2026-10-31), the
 * gated clean-speech rig row failed, so it ships OFF until a REAL call on the bench phones sounds
 * good with it on. OFF builds nothing - no AudioContext, no worklet - until the user turns it on.
 */
export const CALL_NOISE_SUPPRESSION_DEFAULT = false;

/** Why the primary path did not build: one value per cause, so the log line names it. */
export type NoiseSuppressionFailure =
  | 'no-audio-worklet'
  | 'no-media-stream-destination'
  | 'sample-rate'
  | 'worklet-module'
  | 'wasm-fetch'
  | 'worklet-init'
  | 'graph'
  | 'context'
  /** The call ended (its `AbortSignal`) before the build settled: not a defect, a release. */
  | 'cancelled';

/** What the worklet last counted (`stats` on its port). */
export interface NoiseSuppressionStats {
  frames: number;
  busyMs: number;
  maxQuantumMs: number;
  clock: string;
}

/** What `buildCallMicPipeline` needs from the platform - injected, so it is tested without one. */
export interface CallMicPipelineDeps {
  /** A 48 kHz, interactive `AudioContext` (`new AudioContext({ sampleRate: 48000 })`). */
  createContext(): AudioContext;
  /** The worklet module's URL (`workers/rnnoise.worklet.ts?worker&url`). */
  workletUrl: string;
  /** The RNNoise wasm bytes, fetched from the app's own origin. */
  loadWasm(): Promise<ArrayBuffer>;
  log(msg: string): void;
}

/** A pipeline that built: the processed track and what proves it may be sent. */
export interface CallMicPipeline {
  /** The track the worklet's output feeds. Sent only while {@link usable} says so. */
  readonly processed: MediaStreamTrack;
  /** The worklet answered `ready` and its context runs: its output carries the microphone. */
  usable(): boolean;
  /** The context's state, for the log line that names why the pipeline is not usable. */
  contextState(): string;
  /** The worklet's last `stats`, or `null` before the first (~5 s of audio). */
  stats(): NoiseSuppressionStats | null;
  /** Called on every change of {@link usable}: the call re-decides which track it sends. */
  onUsableChange(listener: () => void): void;
  /**
   * The switch's position reaching the engine: OFF suspends the context (no RNNoise runs for a
   * track nobody sends), ON resumes it - called inside the tap, so the engine lets it run.
   */
  setActive(active: boolean): void;
  /** Stops the processed track, the worklet and the context. Idempotent. */
  close(): void;
}

export type CallMicPipelineResult =
  | { ok: true; pipeline: CallMicPipeline }
  | { ok: false; failure: NoiseSuppressionFailure; detail: string };

/** A typed failure carrying its cause, thrown inside the builder and returned by it. */
class PipelineBuildError extends Error {
  constructor(
    readonly failure: NoiseSuppressionFailure,
    detail: string
  ) {
    super(detail);
  }
}

/**
 * The feature test, read BEFORE any context is made: an engine without AudioWorklet or without a
 * MediaStream destination cannot carry the pipeline at all (an old WKWebView), and that is said.
 */
export function noiseSuppressionUnsupported(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): NoiseSuppressionFailure | null {
  if (typeof scope.AudioWorkletNode !== 'function') return 'no-audio-worklet';
  if (typeof scope.MediaStreamAudioDestinationNode !== 'function')
    return 'no-media-stream-destination';
  return null;
}

/**
 * Builds the noise-suppression pipeline on `raw` - or returns WHY it could not, never throws. The
 * call does not wait for it: it sends `raw` until the pipeline is usable (`micTrackToSend`).
 *
 * The worklet's `ready` is awaited as a PROOF, with no clock: a worklet that never answers leaves
 * the call on the raw track, and the call's report then reads `ns=pending` - the accusation. What
 * ENDS that wait is the call's end, through `signal`: aborted, the build settles `cancelled` and
 * releases its context, worklet and source - nothing it made outlives the call.
 */
export async function buildCallMicPipeline(
  raw: MediaStreamTrack,
  deps: CallMicPipelineDeps,
  signal?: AbortSignal
): Promise<CallMicPipelineResult> {
  deps.log('[Call] noise suppression: building the RNNoise pipeline on the microphone');
  const unsupported = noiseSuppressionUnsupported();
  if (unsupported) {
    return { ok: false, failure: unsupported, detail: 'this engine lacks it' };
  }
  if (signal?.aborted) {
    return { ok: false, failure: 'cancelled', detail: 'the call ended before the build began' };
  }
  // Rejects once the call ends; every wait below races it, so an abort settles the build at once.
  const cancelled = new Promise<never>((_, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(new PipelineBuildError('cancelled', 'the call ended before the build settled')),
      { once: true }
    );
  });
  // A build that settled first never reads it; its rejection is the race's, already handled.
  cancelled.catch(() => undefined);
  let ctx: AudioContext | null = null;
  let processedTrack: MediaStreamTrack | null = null;
  try {
    try {
      ctx = deps.createContext();
    } catch (e) {
      // An engine refusing a 48 kHz context (or any context: too many open) says so here.
      throw new PipelineBuildError('context', String(e));
    }
    if (ctx.sampleRate !== 48_000) {
      throw new PipelineBuildError('sample-rate', `the context runs at ${ctx.sampleRate} Hz`);
    }
    const context = ctx;
    const [, wasm] = await Promise.race([
      Promise.all([
        context.audioWorklet.addModule(deps.workletUrl).catch((e: unknown) => {
          throw new PipelineBuildError('worklet-module', String(e));
        }),
        deps.loadWasm().catch((e: unknown) => {
          throw new PipelineBuildError('wasm-fetch', String(e));
        }),
      ]),
      cancelled,
    ]);
    let source: MediaStreamAudioSourceNode;
    let node: AudioWorkletNode;
    let dest: MediaStreamAudioDestinationNode;
    try {
      source = context.createMediaStreamSource(new MediaStream([raw]));
      node = new AudioWorkletNode(context, CALL_NOISE_SUPPRESSOR_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [1],
        processorOptions: { wasm },
      });
      dest = context.createMediaStreamDestination();
      dest.channelCount = 1;
      source.connect(node);
      node.connect(dest);
    } catch (e) {
      throw new PipelineBuildError('graph', String(e));
    }
    const processed = dest.stream.getAudioTracks()[0];
    if (!processed) throw new PipelineBuildError('graph', 'the destination has no audio track');
    processedTrack = processed;
    // The engine may hold a context suspended until a gesture; the state is READ, never assumed.
    resumeContext(context, deps);
    const pipeline = await Promise.race([
      awaitReady(context, source, node, processed, deps),
      cancelled,
    ]);
    return { ok: true, pipeline };
  } catch (e) {
    // Everything the build made goes with it: the processed track, then the context (which takes
    // the worklet and the source with it).
    processedTrack?.stop();
    void ctx?.close().catch((closeError: unknown) => {
      deps.log(`[Call] noise suppression: AudioContext.close refused: ${String(closeError)}`);
    });
    if (e instanceof PipelineBuildError) {
      return { ok: false, failure: e.failure, detail: e.message };
    }
    return { ok: false, failure: 'graph', detail: String(e) };
  }
}

function resumeContext(ctx: AudioContext, deps: CallMicPipelineDeps): void {
  void ctx.resume().catch((e: unknown) => {
    deps.log(`[Call] WARN noise suppression: AudioContext.resume refused: ${String(e)}`);
  });
}

/** Resolves once the worklet answered `ready`; rejects (typed) on its `error` or a processor error. */
function awaitReady(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
  node: AudioWorkletNode,
  processed: MediaStreamTrack,
  deps: CallMicPipelineDeps
): Promise<CallMicPipeline> {
  let ready = false;
  let closed = false;
  let dead = false;
  let lastStats: NoiseSuppressionStats | null = null;
  const listeners: (() => void)[] = [];
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (e) {
        deps.log(`[Call] WARN noise suppression: a usable-change listener threw: ${String(e)}`);
      }
    }
  };
  const pipeline: CallMicPipeline = {
    processed,
    usable: () => ready && !closed && !dead && ctx.state === 'running',
    contextState: () => ctx.state,
    stats: () => lastStats,
    onUsableChange: (listener) => listeners.push(listener),
    setActive: (active) => {
      if (closed) return;
      if (active) {
        resumeContext(ctx, deps);
        return;
      }
      void ctx.suspend().catch((e: unknown) => {
        deps.log(`[Call] WARN noise suppression: AudioContext.suspend refused: ${String(e)}`);
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      node.port.postMessage('destroy');
      node.port.onmessage = null;
      ctx.onstatechange = null;
      try {
        source.disconnect();
        node.disconnect();
      } catch (e) {
        deps.log(`[Call] noise suppression: disconnect on close threw: ${String(e)}`);
      }
      processed.stop();
      void ctx.close().catch((e: unknown) => {
        deps.log(`[Call] noise suppression: AudioContext.close refused: ${String(e)}`);
      });
    },
  };
  ctx.onstatechange = () => {
    deps.log(`[Call] noise suppression: AudioContext ${ctx.state}`);
    notify();
  };
  return new Promise((resolve, reject) => {
    node.onprocessorerror = (e: Event) => {
      const detail = `processorerror: ${String((e as ErrorEvent).message ?? e.type)}`;
      if (!ready) {
        reject(new PipelineBuildError('worklet-init', detail));
        return;
      }
      // After ready: the processor died mid-call. Its output is silence from now on.
      deps.log(`[Call] WARN noise suppression: the worklet died mid-call (${detail})`);
      dead = true;
      notify();
    };
    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; detail?: string } & Partial<NoiseSuppressionStats>;
      if (msg.type === 'ready') {
        ready = true;
        deps.log(
          `[Call] noise suppression: worklet ready (context ${ctx.state}, clock ${msg.clock})`
        );
        resolve(pipeline);
        notify();
      } else if (msg.type === 'error') {
        reject(new PipelineBuildError('worklet-init', msg.detail ?? 'unnamed worklet error'));
      } else if (msg.type === 'stats') {
        lastStats = {
          frames: msg.frames ?? 0,
          busyMs: msg.busyMs ?? 0,
          maxQuantumMs: msg.maxQuantumMs ?? 0,
          clock: msg.clock ?? '?',
        };
      }
    };
  });
}

/**
 * THE ONE DECISION of which microphone track the call sends: the processed one only when the user
 * left suppression on AND a pipeline exists AND it is usable; the raw capture otherwise.
 */
export function micTrackToSend(
  raw: MediaStreamTrack,
  pipeline: CallMicPipeline | null,
  enabled: boolean
): MediaStreamTrack {
  return enabled && pipeline?.usable() ? pipeline.processed : raw;
}

/** The `ns=` field of a `[CALL_REPORT]`: what the microphone sender carries, and why. */
export type NoiseSuppressionReportState = 'on' | 'off' | 'pending' | 'unavailable';

/** The `ns=` value from the call's facts (`CallService.noiseSuppressionReport`). */
export function noiseSuppressionReportState(
  enabled: boolean,
  pipeline: CallMicPipeline | null,
  failed: boolean
): NoiseSuppressionReportState {
  if (!enabled) return 'off';
  if (pipeline?.usable()) return 'on';
  return failed ? 'unavailable' : 'pending';
}

/**
 * The once-per-call cost line: the worklet's time per 10 ms frame, and that as a share of real
 * time (one frame is 10 ms of audio). `null` stats - a call shorter than ~5 s of processed audio,
 * or a pipeline that never ran - says so instead of inventing a number.
 */
export function describeNoiseSuppressionCost(
  state: NoiseSuppressionReportState,
  stats: NoiseSuppressionStats | null,
  fallbacks: number
): string {
  const head = `[Call] noise suppression end: ns=${state} ns_fallbacks=${fallbacks}`;
  if (!stats || stats.frames === 0) return `${head} frames=0 cost=- (no stats from the worklet)`;
  const perFrame = stats.busyMs / stats.frames;
  return (
    `${head} frames=${stats.frames} cost_ms_per_frame=${perFrame.toFixed(3)} ` +
    `realtime_pct=${((perFrame / 10) * 100).toFixed(1)} max_quantum_ms=${stats.maxQuantumMs.toFixed(2)} ` +
    `clock=${stats.clock}`
  );
}

/** What the call screen reads: the user's choice for this call, and what the sender carries. */
export interface NoiseSuppressionView {
  enabled: boolean;
  state: NoiseSuppressionReportState;
}

/** The call screen's view before a microphone opens: the default switch, nothing built yet. */
export function initialNoiseSuppressionView(): NoiseSuppressionView {
  return noiseSuppressionView(CALL_NOISE_SUPPRESSION_DEFAULT, null, false);
}

function noiseSuppressionView(
  enabled: boolean,
  pipeline: CallMicPipeline | null,
  failed: boolean
): NoiseSuppressionView {
  return { enabled, state: noiseSuppressionReportState(enabled, pipeline, failed) };
}

/**
 * ONE CALL'S MICROPHONE SENDER: which track it carries, changed only through
 * {@link micTrackToSend} and `replaceTrack` on the same sender. Owns the pipeline once it is
 * adopted, the user's per-call switch, and the count of times the primary path failed
 * (`[CALL_REPORT] ns_fallbacks=`): a build that failed, a processed path that stopped carrying
 * while it was sent (a context the engine suspended, a worklet that died), a `replaceTrack` the
 * engine refused. Every such event logs at WARN with its cause.
 *
 * `replaceTrack` calls run one after another (a promise chain), each reading the decision at the
 * moment it runs, so a switch tapped twice quickly ends on the last tap's track.
 */
export class CallMicSwitch {
  private pipeline: CallMicPipeline | null = null;
  private failed = false;
  /** The build in flight, cancelled by {@link close}: the call's end settles it, no clock. */
  private building: AbortController | null = null;
  /** The worklet stopped counting frames while its track was sent (`checkProgress`). */
  private stalled = false;
  /** The worklet's frame count at the last report tick that found the processed track sent. */
  private framesAtLastTick: number | null = null;
  private fallbacks = 0;
  private sender: RTCRtpSender | null = null;
  private closed = false;
  /** What the sender carried after the last applied decision. */
  private sent: 'raw' | 'processed' = 'raw';
  private chain: Promise<void> = Promise.resolve();

  /**
   * @param raw The capture track (echo-cancelled by the engine), kept in the call's local stream.
   * @param enabled The switch's starting position ({@link CALL_NOISE_SUPPRESSION_DEFAULT} in a call).
   * @param log The call's log sink.
   * @param publish Told every change of {@link view}, for the call screen.
   */
  constructor(
    readonly raw: MediaStreamTrack,
    private enabled: boolean,
    private readonly log: (msg: string) => void,
    private readonly publish: (view: NoiseSuppressionView) => void
  ) {
    this.publish(this.view());
  }

  /** The track a NEW sender starts with (`addTrack`): the decision as it stands now. */
  trackToSend(): MediaStreamTrack {
    return micTrackToSend(this.raw, this.live(), this.enabled);
  }

  /** The pipeline the decision may use: none once it was caught not processing. */
  private live(): CallMicPipeline | null {
    return this.stalled ? null : this.pipeline;
  }

  /** The audio sender of the call's current peer connection, created with {@link trackToSend}. */
  attachSender(sender: RTCRtpSender): void {
    this.log(`[Call] noise suppression: microphone sender attached (ns=${this.reportState()})`);
    this.sender = sender;
    this.sent = this.pipeline && sender.track === this.pipeline.processed ? 'processed' : 'raw';
    this.sync('a new sender');
  }

  /** Takes the builder's result: a pipeline to switch to, or a failure to say and count. */
  adopt(result: CallMicPipelineResult): void {
    if (this.closed) {
      this.log('[Call] noise suppression: pipeline settled after the call ended - released');
      if (result.ok) result.pipeline.close();
      return;
    }
    if (!result.ok) {
      this.failed = true;
      this.fallbacks += 1;
      this.log(
        `[Call] WARN noise suppression unavailable (${result.failure}: ${result.detail}) - the raw microphone is sent`
      );
      this.publish(this.view());
      return;
    }
    this.pipeline = result.pipeline;
    result.pipeline.onUsableChange(() => this.sync('the pipeline changed state'));
    // Switched OFF while it built: nothing runs for a track nobody sends.
    if (!this.enabled) result.pipeline.setActive(false);
    this.sync('the pipeline is ready');
  }

  /**
   * The proof the processed track still carries the microphone, read at each `[CALL_REPORT]` tick
   * (10 s; the worklet counts frames every 5 s): `usable()` reads the context's state, which the
   * engine may report `running` while the worklet no longer processes. While the sender carries
   * the processed track, a frame count that did not advance since the last tick sends the raw
   * capture again - a WARN, counted in `ns_fallbacks`, and not retried this call.
   */
  checkProgress(): void {
    if (this.closed || this.stalled || !this.sendsProcessed()) {
      this.framesAtLastTick = null;
      return;
    }
    const frames = this.pipeline?.stats()?.frames ?? 0;
    const previous = this.framesAtLastTick;
    this.framesAtLastTick = frames;
    if (previous === null || frames > previous) return;
    this.stalled = true;
    this.fallbacks += 1;
    this.log(
      `[Call] WARN noise suppression stopped processing (frames ${frames} since the last tick, context ${this.pipeline?.contextState()}) - the raw microphone is sent`
    );
    this.sync('the worklet stopped counting frames');
  }

  /**
   * Builds the pipeline the first time the switch is ON, and only then: with the switch OFF a
   * call pays for no AudioContext and no worklet. One build per call - a build in flight, a
   * pipeline held or a build that failed (`ns=unavailable`, the switch hidden) is not retried.
   */
  ensurePipeline(build: (signal: AbortSignal) => Promise<CallMicPipelineResult>): void {
    if (!this.enabled || this.closed || this.building || this.pipeline || this.failed) return;
    const building = new AbortController();
    this.building = building;
    this.log('[Call] noise suppression: building the pipeline (the switch is on)');
    void build(building.signal).then((result) => {
      if (this.building === building) this.building = null;
      this.adopt(result);
    });
  }

  /** The user's switch, for THIS call only. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.log(`[Call] noise suppression switched ${enabled ? 'ON' : 'OFF'} by the user`);
    this.pipeline?.setActive(enabled);
    this.sync(enabled ? 'the user switched it on' : 'the user switched it off');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** The `ns=` field of `[CALL_REPORT]`. */
  reportState(): NoiseSuppressionReportState {
    return noiseSuppressionReportState(this.enabled, this.live(), this.failed || this.stalled);
  }

  /** The `ns_fallbacks=` field of `[CALL_REPORT]`: how many times the primary path failed. */
  fallbackCount(): number {
    return this.fallbacks;
  }

  view(): NoiseSuppressionView {
    return noiseSuppressionView(this.enabled, this.live(), this.failed || this.stalled);
  }

  /** The worklet's last counts (frames, time spent), or `null`: what the end line is made of. */
  stats(): NoiseSuppressionStats | null {
    return this.pipeline?.stats() ?? null;
  }

  /** The sender carries the processed track right now (a measurement reads it, the call does not). */
  sendsProcessed(): boolean {
    return !!this.pipeline && this.sender?.track === this.pipeline.processed;
  }

  /** Settles once every queued `replaceTrack` has run (tests, and nothing else, wait on it). */
  settled(): Promise<void> {
    return this.chain;
  }

  /** The call is over: one cost line (the worklet's time per frame), then the pipeline goes. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.log(
      describeNoiseSuppressionCost(
        this.reportState(),
        this.pipeline?.stats() ?? null,
        this.fallbacks
      )
    );
    this.pipeline?.close();
    this.pipeline = null;
    this.sender = null;
    // A build still waiting on its worklet's proof ends with the call, and releases its context.
    this.building?.abort();
    this.building = null;
  }

  /** Queues one decision; every step settles, so one refusal never blocks the next. */
  private sync(why: string): void {
    this.publish(this.view());
    this.chain = this.chain.then(() => this.apply(why));
  }

  private async apply(why: string): Promise<void> {
    const sender = this.sender;
    if (this.closed || !sender) return;
    const track = this.trackToSend();
    const next = track === this.raw ? 'raw' : 'processed';
    if (
      next === 'raw' &&
      this.sent === 'processed' &&
      this.enabled &&
      this.pipeline &&
      !this.pipeline.usable()
    ) {
      this.fallbacks += 1;
      this.log(
        `[Call] WARN noise suppression stopped carrying the microphone (context ${this.pipeline.contextState()}) - the raw microphone is sent`
      );
    }
    if (sender.track === track) {
      this.sent = next;
      return;
    }
    try {
      await sender.replaceTrack(track);
      this.sent = next;
      this.log(
        `[Call] microphone sender now carries the ${next} track (${why}; replaceTrack: same sender, same transform)`
      );
    } catch (e) {
      this.fallbacks += 1;
      this.log(`[Call] WARN microphone replaceTrack(${next}) refused (${why}): ${String(e)}`);
    }
    this.publish(this.view());
  }
}
