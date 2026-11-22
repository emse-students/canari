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
 * The stream a voice note records from `microphone`: the microphone itself when its track reports
 * mono, its one-channel downmix otherwise. Throws when the engine refuses the graph - the recorder
 * then reports the microphone as unusable, as for any other start that fails: a note recorded in a
 * layout that plays out of one side is not sent instead.
 */
export function monoRecordingStream(
  microphone: MediaStream,
  createContext: CreateAudioContext
): RecordedStream {
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
  try {
    const source = context.createMediaStreamSource(microphone);
    const sink = context.createMediaStreamDestination();
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
    if (context.state !== 'running') {
      context.resume().catch((e: unknown) => {
        // The one way this graph records silence: said at the level that accuses.
        console.error(
          '[VoiceRecorder] the downmix context did not start: this note records silence',
          e
        );
      });
    }
    let released = false;
    return {
      stream: sink.stream,
      granted,
      downmixed: true,
      release() {
        if (released) return;
        released = true;
        context.onstatechange = null;
        source.disconnect();
        sink.stream.getTracks().forEach((track) => track.stop());
        context
          .close()
          .catch((e: unknown) => Log.w('VoiceRecorder', 'the downmix context did not close', e));
      },
    };
  } catch (e) {
    context
      .close()
      .catch((closeError: unknown) =>
        Log.w('VoiceRecorder', 'the refused downmix context did not close', closeError)
      );
    throw e;
  }
}
