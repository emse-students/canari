/**
 * A VOICE NOTE'S SOUND, MEASURED WHILE IT IS RECORDED (owner, 2026-11-12; review of #3394): the same
 * BS.1770 measurement a video gets (`video/loudnessMeter.ts`, `MediaRef.loudness`,
 * `MediaMsg.loudness`), so every reader's player brings a whispered note and a shouted one toward
 * one loudness through the one playback law (`video/loudnessPlayback.ts`).
 *
 * MEASURED DURING THE RECORDING, NOT AFTER IT: the microphone's stream is tapped by an AudioWorklet
 * (`workers/loudnessTap.worklet.ts`) that posts its samples in batches, and the page feeds them to
 * {@link LoudnessMeter} as they arrive. When the finger lifts, the measurement is already made - the
 * send waits for nothing, and the recording is never decoded a second time.
 *
 * THE GRAPH: `MediaStreamSource -> AudioWorkletNode -> MediaStreamAudioDestinationNode`, on a context
 * of its own made for this recording and CLOSED when it stops. The destination is a sink nobody
 * plays - the call microphone's pattern (`utils/callNoiseSuppression.ts`) - so nothing reaches the
 * speaker. A realtime context still opens a platform stream while it exists (`utils/toneOutput.ts`);
 * it lives exactly as long as the recording, in the foreground.
 *
 * WHAT IT DOES NOT SEE: the samples before the worklet module has loaded (the first tens of ms of
 * the first recording of a session; the module is cached after), and a batch still in flight when
 * the recording stops (at most ~43 ms). The integrated loudness is a gated mean over 400 ms blocks,
 * so neither moves it measurably; both are said in the line the stop logs (frames measured against
 * the recording's length).
 *
 * NEVER A REFUSAL: an engine without AudioWorklet, a module that will not load, a graph the engine
 * refuses - the note is sent UNMEASURED and plays exactly as every note before this did, and the
 * cause is logged at `warn`.
 */

import { Log } from '$lib/utils/Log';
import { LoudnessMeter, type MediaLoudness } from '$lib/video/loudnessMeter';
import type { LoudnessTapBatch } from '$lib/workers/loudnessTap.worklet';

/** The processor name `workers/loudnessTap.worklet.ts` registers. */
export const LOUDNESS_TAP_PROCESSOR = 'canari-loudness-tap';

/**
 * The page's half of the tap: the batches the worklet posts, fed to ONE {@link LoudnessMeter}. The
 * meter is made on the first batch, when the channel count is known.
 */
export class RecordingLoudness {
  readonly sampleRate: number;
  #meter: LoudnessMeter | null = null;
  #frames = 0;
  #mismatchSaid = false;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  /** The frames measured so far. */
  get frames(): number {
    return this.#frames;
  }

  /** Feeds one batch, as the worklet posted it. */
  accept(batch: LoudnessTapBatch): void {
    if (batch.frames <= 0 || batch.planes.length === 0) return;
    this.#meter ??= new LoudnessMeter(this.sampleRate, batch.planes.length);
    if (batch.planes.length !== this.#meter.channelCount) {
      // The meter's channel weights are fixed at its first batch; a change of layout mid-recording
      // is not something a microphone does, so it is said and the odd batch is left out.
      if (!this.#mismatchSaid) {
        this.#mismatchSaid = true;
        console.warn(
          `[LOUDNESS] the recording changed from ${this.#meter.channelCount} to ` +
            `${batch.planes.length} channel(s): those batches are not measured`
        );
      }
      return;
    }
    this.#meter.push(batch.planes, batch.frames);
    this.#frames += batch.frames;
  }

  /** The measurement of everything accepted: null for silence, or nothing (`LoudnessMeter.result`). */
  result(): MediaLoudness | null {
    return this.#meter?.result() ?? null;
  }
}

/** What the tap needs from the platform - the real one in the app, a fake in a test. */
export interface RecordingLoudnessDeps {
  /** A NEW realtime `AudioContext`. */
  createContext(): AudioContext;
  /** The worklet module's URL (`workers/loudnessTap.worklet.ts?worker&url`). */
  workletUrl: string;
}

/** A recording's tap, from its start to its stop. */
export interface RecordingLoudnessTap {
  /**
   * Ends the tap - graph disconnected, context closed - and returns the measurement made so far:
   * null when nothing could be measured, or only silence. Synchronous: the send never waits on it.
   */
  stop(): MediaLoudness | null;
}

/**
 * Starts measuring `stream` (the microphone the recorder records). Returns at once: the worklet
 * module loads in the background and the batches flow once it has.
 */
export function tapRecordingLoudness(
  stream: MediaStream,
  deps: RecordingLoudnessDeps
): RecordingLoudnessTap {
  if (typeof AudioWorkletNode !== 'function') {
    console.warn('[LOUDNESS] no AudioWorklet in this engine - the voice note is sent unmeasured');
    return { stop: () => null };
  }
  let context: AudioContext;
  try {
    context = deps.createContext();
  } catch (e) {
    console.warn('[LOUDNESS] no AudioContext for the recording - sent unmeasured:', e);
    return { stop: () => null };
  }
  const measured = new RecordingLoudness(context.sampleRate);
  let stopped = false;
  let teardown: (() => void) | null = null;
  const startedAt = context.currentTime;
  Log.d('LOUDNESS', `tapping the recording at ${context.sampleRate} Hz`);

  context.audioWorklet.addModule(deps.workletUrl).then(
    () => {
      if (stopped) return;
      try {
        const source = context.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(context, LOUDNESS_TAP_PROCESSOR, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        const sink = context.createMediaStreamDestination();
        node.port.onmessage = (event: MessageEvent<LoudnessTapBatch>) => {
          if (!stopped) measured.accept(event.data);
        };
        source.connect(node);
        node.connect(sink);
        teardown = () => {
          node.port.onmessage = null;
          source.disconnect();
          node.disconnect();
        };
      } catch (e) {
        console.warn('[LOUDNESS] the recording tap graph was refused - sent unmeasured:', e);
        return;
      }
      // An engine may hold a new context suspended; the recorder's press is the gesture.
      if (context.state !== 'running') {
        context.resume().catch((e: unknown) => {
          console.warn('[LOUDNESS] the recording tap could not resume its context:', e);
        });
      }
    },
    (e: unknown) => {
      console.warn('[LOUDNESS] the loudness tap module did not load - sent unmeasured:', e);
    }
  );

  return {
    stop() {
      if (stopped) return null;
      stopped = true;
      teardown?.();
      const seconds = context.currentTime - startedAt;
      context
        .close()
        .catch((e: unknown) => console.warn('[LOUDNESS] the recording tap did not close:', e));
      const loudness = measured.result();
      Log.d(
        'LOUDNESS',
        loudness
          ? `voice note measured while recorded: ${loudness.integratedLufs.toFixed(1)} LUFS, peak ` +
              `${loudness.samplePeakDbfs.toFixed(1)} dBFS, ` +
              `${(measured.frames / measured.sampleRate).toFixed(2)} s of ${seconds.toFixed(2)} s`
          : `voice note not measured (${measured.frames} frame(s) received): sent unmeasured`
      );
      return loudness;
    },
  };
}
