import { Log } from '$lib/utils/Log';
import { audioLayoutOf, type AudioLayout } from '$lib/utils/audioLayout';

/**
 * A VOICE NOTE IS RECORDED IN ONE CHANNEL, WHATEVER THE ENGINE GRANTED (iPhone 12, `1.7.3-alpha.4`:
 * a note recorded there was AAC with TWO channels, while #3934 asked `channelCount: { ideal: 1 }`).
 *
 * WHY ASKING IS NOT ENOUGH. `channelCount` is a constraint an engine may not implement: WebKit lists
 * it in no `getSupportedConstraints()` and reports it in no `getSettings()`, so the request is
 * ignored there, and with echo cancellation off (#3934) WebKit captures through RemoteIO, which hands
 * the built-in microphones over as two channels. WebKit's recorder writes the AAC file with the
 * channel count of the samples it receives. So the recorder must RECEIVE mono.
 *
 * THE DECISION IS A FACT READ ONCE, at the start of each recording: a track that REPORTS one channel
 * is recorded as granted (Android's WebView, desktop Chromium - no graph, nothing added); any other
 * answer - two channels, or none reported - is downmixed by the engine's own Web Audio graph:
 * `MediaStreamSource -> MediaStreamAudioDestinationNode` with the destination pinned to ONE channel
 * (`channelCountMode: 'explicit'`, `channelInterpretation: 'speakers'`, the spec's L/R average). The
 * recorder records the destination's stream; the measured loudness is taken on that same stream, so
 * the playback normalisation reads the file that was sent.
 *
 * THE CONTEXT RUNS FROM THE START. The context is made while the page holds an open capture, which
 * every engine lets start without a new gesture (WebKit: a capturing page may start audio). Its state
 * is logged as made and on every change (`statechange`, an event, never a timer), so a context the
 * engine kept suspended - the one way this graph would record silence - is named in the log of that
 * very note; the reading of the note's loudness (`voice note measured while recorded`) is its
 * second witness.
 */

/** What the recorder records, and how to give it back. */
export interface RecordedStream {
  /** The stream handed to `MediaRecorder` and to the loudness tap. */
  stream: MediaStream;
  /** The layout the microphone track reported, which decided the path. */
  granted: AudioLayout;
  /** Whether the stream is the engine's downmix rather than the microphone's own track. */
  downmixed: boolean;
  /** Ends the graph and closes its context; idempotent; nothing to do for a stream as granted. */
  release(): void;
}

/** What the downmix needs from the platform: the app's `AudioContext`, a fake in a test. */
export type CreateAudioContext = (sampleRate?: number) => AudioContext;

/**
 * The downmix's context did not reach `running`: its graph would record SILENCE, and a silent note
 * sent is a note lost (principle 2). Typed, so the recorder's refusal branch releases everything and
 * says the microphone is unusable, rather than sending nothing as if it were a message.
 */
export class DownmixNotRunningError extends Error {
  constructor(readonly state: AudioContextState) {
    super(`the one-channel downmix context is ${state}, not running`);
    this.name = 'DownmixNotRunningError';
  }
}

/**
 * The stream a voice note records from `microphone`: the microphone itself when its track reports
 * mono, its one-channel downmix otherwise - resolved only once that downmix's context RUNS (awaited
 * `resume()`), so the recorder never starts on a graph that renders silence. Rejects when the engine
 * refuses the graph or the context does not run ({@link DownmixNotRunningError}); everything it made
 * is closed first. The recorder then reports the microphone as unusable, as for any other start that
 * fails: neither a silent note nor one that plays out of one side is sent instead.
 */
export async function monoRecordingStream(
  microphone: MediaStream,
  createContext: CreateAudioContext
): Promise<RecordedStream> {
  const settings = microphone.getAudioTracks?.()[0]?.getSettings?.() ?? {};
  const granted = audioLayoutOf(settings.channelCount);
  if (granted === 'mono') {
    Log.d('VoiceRecorder', 'the microphone reports one channel: recorded as granted');
    return { stream: microphone, granted, downmixed: false, release: () => {} };
  }
  const trackRate = settings.sampleRate;
  const context = createContext(
    typeof trackRate === 'number' && trackRate > 0 ? trackRate : undefined
  );
  let source: MediaStreamAudioSourceNode | null = null;
  let sink: MediaStreamAudioDestinationNode | null = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    context.onstatechange = null;
    source?.disconnect();
    sink?.stream.getTracks().forEach((track) => track.stop());
    context
      .close()
      .catch((e: unknown) => Log.w('VoiceRecorder', 'the downmix context did not close', e));
  };
  try {
    source = context.createMediaStreamSource(microphone);
    sink = context.createMediaStreamDestination();
    sink.channelCount = 1;
    sink.channelCountMode = 'explicit';
    sink.channelInterpretation = 'speakers';
    source.connect(sink);
    Log.i(
      'VoiceRecorder',
      `the microphone reports ${granted} (ch=${settings.channelCount ?? 'unreported'}): ` +
        `recorded through a one-channel downmix at ${context.sampleRate} Hz, context ${context.state}`
    );
    context.onstatechange = () => {
      Log.i('VoiceRecorder', `downmix context ${context.state}`);
    };
    if (context.state !== 'running') await context.resume();
    if (context.state !== 'running') throw new DownmixNotRunningError(context.state);
    return { stream: sink.stream, granted, downmixed: true, release };
  } catch (e) {
    // The one way this graph would record silence, or a graph refused: said at the level that
    // accuses, and nothing it made is left open.
    console.error('[VoiceRecorder] the one-channel downmix did not start - nothing recorded:', e);
    release();
    throw e;
  }
}
