/**
 * THE SOUND OF A DESKTOP LIVE (owner, 2026-11-14): the microphone and the shared screen's own sound
 * (a tab's or the system's, when the picker offered it and the member ticked it) mixed in one
 * `AudioContext` into ONE track - the one the recorder records for the whole live. Each input has its
 * own gain: muting the microphone is its gain at 0, never the recorder's track stopped, and a scene
 * that does not show the screen silences the share's sound the same way. An input replaced (a
 * microphone re-opened, a screen granted mid-live) is reconnected behind the same output, so the
 * recorder never sees its tracks change.
 *
 * THE CONTEXT MUST RUN, OR NOTHING IS RECORDED. Measured on Chrome 2026-11-14: a `MediaRecorder` on
 * an MP4 with the audio of a SUSPENDED context emits no chunk at all - not a silent live, no live. A
 * context only starts inside a click (Safari) or after one (Chrome's autoplay rule), so
 * {@link wake} is called from every click of the live's screen and {@link state} is READ - never
 * awaited, since a `resume()` outside a gesture can stay pending for ever.
 */

/** What the mixer needs of the Web Audio API (a fake in tests). */
export type MixerContext = Pick<
  AudioContext,
  | 'state'
  | 'resume'
  | 'close'
  | 'createGain'
  | 'createMediaStreamSource'
  | 'createMediaStreamDestination'
> &
  Pick<EventTarget, 'addEventListener'>;

export class LiveAudioMixer {
  /** The context's state, followed through its `statechange`: `running` is the only one that records. */
  state = $state<AudioContextState>('suspended');
  /** The mixed sound: the ONE audio track a desktop live records. */
  readonly track: MediaStreamTrack;
  readonly #context: MixerContext;
  readonly #micGain: GainNode;
  readonly #shareGain: GainNode;
  #micInput: AudioNode | null = null;
  #shareInput: AudioNode | null = null;
  #micMuted = false;
  #shareAudible = false;
  #onState: ((state: AudioContextState) => void) | null = null;

  constructor(context: MixerContext) {
    this.#context = context;
    this.state = context.state;
    context.addEventListener('statechange', () => {
      console.debug(`[LIVE-MIX] audio context ${this.#context.state}`);
      this.state = this.#context.state;
      this.#onState?.(this.#context.state);
    });
    const destination = context.createMediaStreamDestination();
    this.#micGain = context.createGain();
    this.#shareGain = context.createGain();
    this.#micGain.connect(destination);
    this.#shareGain.connect(destination);
    this.#applyGains();
    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('live mixer: the destination gave no audio track');
    this.track = track;
    console.debug(`[LIVE-MIX] mixer made, context ${context.state}`);
  }

  /**
   * Who is told of every state the context ENTERS (its `statechange`) - the broadcast, which records
   * only while it is `running` and so must hear it leave and come back, rather than poll for it.
   */
  onStateChange(listener: (state: AudioContextState) => void): void {
    this.#onState = listener;
  }

  /** Asks the context to run. CALL IT FROM A CLICK; never awaited (see the module comment). */
  wake(): void {
    if (this.#context.state === 'running' || this.#context.state === 'closed') return;
    console.debug(`[LIVE-MIX] waking the audio context (${this.#context.state})`);
    this.#context.resume().catch((err: unknown) => {
      console.warn('[LIVE-MIX] the audio context refused to resume', err);
    });
  }

  /** The microphone's track, or null when it is gone; the previous one is disconnected. */
  setMic(track: MediaStreamTrack | null): void {
    this.#micInput?.disconnect();
    this.#micInput = this.#input(track, this.#micGain);
    console.debug(`[LIVE-MIX] microphone ${track ? 'connected' : 'disconnected'}`);
  }

  /** The share's own sound, or null (none offered, or the share is gone). */
  setShare(track: MediaStreamTrack | null): void {
    this.#shareInput?.disconnect();
    this.#shareInput = this.#input(track, this.#shareGain);
    console.debug(`[LIVE-MIX] share sound ${track ? 'connected' : 'disconnected'}`);
  }

  setMicMuted(muted: boolean): void {
    this.#micMuted = muted;
    this.#applyGains();
  }

  /** Whether the share's sound is heard: only while the scene shows the screen. */
  setShareAudible(audible: boolean): void {
    this.#shareAudible = audible;
    this.#applyGains();
  }

  /** Stops the mixed track and closes the context; the inputs' tracks are their owners'. */
  close(): void {
    this.#micInput?.disconnect();
    this.#shareInput?.disconnect();
    this.#micInput = null;
    this.#shareInput = null;
    this.track.stop();
    if (this.#context.state !== 'closed') {
      this.#context.close().catch((err: unknown) => {
        console.warn('[LIVE-MIX] closing the audio context failed', err);
      });
    }
    console.debug('[LIVE-MIX] mixer closed');
  }

  #input(track: MediaStreamTrack | null, gain: GainNode): AudioNode | null {
    if (!track) return null;
    const node = this.#context.createMediaStreamSource(new MediaStream([track]));
    node.connect(gain);
    return node;
  }

  #applyGains(): void {
    this.#micGain.gain.value = this.#micMuted ? 0 : 1;
    this.#shareGain.gain.value = this.#shareAudible ? 1 : 0;
  }
}
