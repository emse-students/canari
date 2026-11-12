/**
 * EVERY VIDEO PLAYS NEAR ONE LOUDNESS (owner, 2026-11-11): the gain a player applies, from the
 * measurement the author's device made at send (`loudnessMeter.ts`, `MediaRef.loudness`).
 *
 * THE LAW ({@link loudnessGainDb}), toward {@link LOUDNESS_TARGET_LUFS} (-14 LUFS, YouTube's and
 * Spotify's reference):
 *
 * - a loud video is LOWERED by what it is over the target, without floor;
 * - a quiet one is RAISED, by at most {@link MAX_BOOST_DB} (+6 dB), and never so far that its
 *   measured sample peak would pass {@link PEAK_CEILING_DBFS} (-1 dBFS) - the peak clamp is what keeps
 *   a raise from clipping, decided from a measured fact rather than by a limiter's guess. The clamp
 *   only limits a RAISE: a quiet video whose peak is already over the ceiling plays at 0 dB, never
 *   lower than it always has;
 * - a gain within {@link GAIN_DEADBAND_DB} of zero is no gain: no graph is built for an inaudible
 *   change;
 * - NO MEASUREMENT, NO GAIN: every video uploaded before this, a live replay, a video whose sound is
 *   silence, plays exactly as it did.
 *
 * WHY NO `DynamicsCompressorNode` AS A LIMITER: the Web Audio compressor applies an automatic
 * make-up gain (spec's "makeup gain", `(1 / fullRangeGain) ^ 0.6`) that would move every routed
 * video's level by a fraction of a dB, and it colours transients. The peak clamp already proves the
 * raise cannot clip on the samples measured; the 1 dB of headroom absorbs what a re-encode moves.
 *
 * THE ROUTE ({@link LoudnessAudio.attach}): `MediaElementAudioSourceNode -> GainNode -> destination`
 * on ONE `AudioContext` for the whole app. What it must respect, each handled here:
 *
 * - **A context starts only after a gesture** (autoplay policy). A MUTED element never needs it: the
 *   graph is built the first time the element is AUDIBLE (unmuted and playing). The reader's unmute
 *   PRIMES the context synchronously inside the gesture ({@link primeLoudnessAudio}, called by
 *   `videoSound.setMuted` and the player's own speaker) - WebKit honours a `resume()` only there. A
 *   context that will not run leaves the element UNROUTED (so it is never silenced) and takes the
 *   fallback below; a `resume()` still unanswered when the element is audible again is said.
 * - **THE APP HOLDS NO AUDIO OUTPUT WHEN NOTHING ROUTED PLAYS** (the Pixel 6a AAudio defect,
 *   `utils/toneOutput.ts`: a context left running kept a platform stream `started` in the background,
 *   and a push thawing the frozen process replayed its buffer as looping noise). The context is
 *   SUSPENDED when no routed element plays (`pause`, `ended`, unmount), resumed on a routed `play`,
 *   and CLOSED when no routed element is mounted any more. Never closed under a mounted routed
 *   element: an element takes ONE source node in its life, so a closed context would strand it
 *   silent for good. THE APP LEAVING THE SCREEN SUSPENDS ONLY IF IDLE (review of #3394): on web and
 *   desktop the arbiter keeps a note the reader started playing behind another tab, and an
 *   unconditional suspend silenced it; on a native phone the arbiter pauses every registered media
 *   first, so the idle check finds nothing playing. It is still needed: a gesture can resume the
 *   context with no routed element playing (an unmute over an unmeasured reel, a refused `play()`).
 *   Only an element registered with the arbiter is routed ({@link LoudnessEnvironment.isArbitrated}).
 * - **Once routed, an element sounds only through the graph** (Web Audio's rule). A context that is
 *   not `running` after the `resume()` of a routed `play` is an element routed and SILENT, and the
 *   line says so at `error`.
 * - **`element.volume` and `muted` keep their meaning**: the engine applies both BEFORE the source
 *   node (Chromium, Firefox, WebKit), so the reader's mute silences the graph and the shared volume
 *   level (PR #3372) multiplies with this gain. Nothing here writes them on the Web Audio route.
 * - **A STREAM ON WEBKIT IS NOT ROUTED** (review of #3378): a `ManagedMediaSource` / MSE element
 *   through `createMediaElementSource` may play SILENT on WebKit with no exception. It keeps only the
 *   fallback's attenuation until the iPhone 12 reading proves sound, said once per element. A blob
 *   is same-origin and is routed.
 * - **Unmount frees the nodes**: the source and the gain are disconnected, so the graph holds no
 *   element alive.
 *
 * THE FALLBACK, AND IT IS ONE: no Web Audio, a source node the engine refuses, a context that does
 * not reach `running`, a WebKit stream. The element then gets the gain through `element.volume` when
 * the gain LOWERS (a volume cannot exceed 1) and the engine honours a written volume - iOS ignores
 * it, which is read back, not assumed. It is logged at `warn`, with its cause, once per element.
 */

import { Log } from '$lib/utils/Log';
import { isArbitrated } from '$lib/actions/playbackArbiter';
import { onAppScreenChange } from '$lib/utils/appForeground';
import { isMediaLoudness, type MediaLoudness } from './loudnessMeter';

/** The loudness every measured video is brought toward. */
export const LOUDNESS_TARGET_LUFS = -14;
/** The most a quiet video is raised. */
export const MAX_BOOST_DB = 6;
/** Where a raise stops, measured against the video's sample peak. */
export const PEAK_CEILING_DBFS = -1;
/** A gain this close to 0 dB is not applied: no audible difference, no graph. */
export const GAIN_DEADBAND_DB = 0.5;

/**
 * The gain, in dB, that brings `loudness` to the target under the law above; 0 for no measurement
 * (an old video), for a measurement a reader cannot trust, and inside the dead band.
 */
export function loudnessGainDb(loudness: MediaLoudness | null | undefined): number {
  if (!isMediaLoudness(loudness)) return 0;
  let gain = LOUDNESS_TARGET_LUFS - loudness.integratedLufs;
  if (gain > 0) {
    const headroom = Math.max(0, PEAK_CEILING_DBFS - loudness.samplePeakDbfs);
    gain = Math.min(gain, MAX_BOOST_DB, headroom);
  }
  return Math.abs(gain) < GAIN_DEADBAND_DB ? 0 : gain;
}

/** dB to a linear amplitude factor. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** What the wiring needs from the platform - the real one in the app, a fake in a test. */
export interface LoudnessEnvironment {
  /** A NEW `AudioContext`; null where the engine has no Web Audio. */
  createContext(): AudioContext | null;
  /** Whether the engine is WebKit, whose MSE elements may play silent through Web Audio. */
  isWebKit(): boolean;
  /**
   * Whether `element` is registered with the playback arbiter (`playbackArbiter.ts`). THE OUTPUT'S
   * LIFETIME RESTS ON IT: the arbiter pauses every registered media when a native app leaves the
   * screen, and that `pause` is what suspends the context here - so an unregistered element is
   * never routed.
   */
  isArbitrated(element: HTMLMediaElement): boolean;
  /**
   * Subscribes to the app leaving or regaining the screen; returns the unsubscribe. On leaving, the
   * context is suspended IF IDLE - a context a gesture resumed with no routed element playing (an
   * unmute over an unmeasured reel, a refused `play()`) would otherwise stay running for ever.
   */
  onScreenChange(onChange: (onScreen: boolean) => void): () => void;
}

/** A video's loudness wiring, for as long as its element is mounted. */
export interface LoudnessHandle {
  /** The element's measurement (null: none) - applied now, or when it is first audible. */
  setLoudness(loudness: MediaLoudness | null | undefined): void;
  /**
   * The reader's gesture (an unmute, a play tap): makes and resumes the context INSIDE it (WebKit),
   * and returns that `resume()`'s settlement - a caller that awaits it before `play()` starts the
   * element at its corrected level, never loud for the first syllable. `null`: nothing to wait for
   * (no gain, no context, one already running, or one in a state no gesture brings back -
   * `interrupted`, `closed` - where the element takes the volume fallback), and `play()` stays in
   * the gesture's own turn.
   */
  prime(): Promise<void> | null;
  /** The element is going away: nodes released, the context suspended or closed if unused. */
  destroy(): void;
}

/**
 * Each element that has been routed, with its source node: an element accepts one source node in
 * its life, and from then on sounds only through the graph of THAT node's context.
 */
const routedSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

/** The factor the fallback put on an element's `volume`, so a level written later keeps it. */
const fallbackFactors = new WeakMap<HTMLMediaElement, number>();

/**
 * The `volume` an element should carry for the reader's `level` (0..1): the level itself, times the
 * loudness factor where the fallback route applied one. THE ONE PLACE a level reaches an element
 * that may be on the fallback - the shared volume level (PR #3372, `applyVideoLevel`) writes through
 * this, and reads back through {@link readerLevelOf}, so it never erases the attenuation.
 */
export function elementVolumeFor(video: HTMLMediaElement, level: number): number {
  return Math.min(1, Math.max(0, level * (fallbackFactors.get(video) ?? 1)));
}

/** The reader's level behind an element's `volume`, the fallback's factor divided out. */
export function readerLevelOf(video: HTMLMediaElement): number {
  return Math.min(1, video.volume / (fallbackFactors.get(video) ?? 1));
}

/**
 * THE APP'S ONE AUDIO OUTPUT FOR VIDEO LOUDNESS: one context, made on first need, suspended while no
 * routed element plays and closed once none is mounted (see the module comment).
 */
export class LoudnessAudio {
  #context: AudioContext | null = null;
  #unavailable = false;
  /** Handles whose element is routed through the current context. */
  readonly #routed = new Set<RouteHandle>();
  /** Routed elements playing right now. */
  readonly #playing = new Set<HTMLMediaElement>();
  /** Handles that want a route (a gain to apply), for the unmute gesture's prime. */
  readonly #wanting = new Set<RouteHandle>();
  #unsubscribeScreen: (() => void) | null = null;
  /** A `suspended` context's resume a gesture is waiting on, until it answers. */
  #waitedResume: Promise<void> | null = null;

  constructor(readonly env: LoudnessEnvironment) {}

  /** Starts the wiring of `video`; `streamed` says its source is a MediaSource. */
  attach(video: HTMLMediaElement, options: { streamed: boolean }): LoudnessHandle {
    return new RouteHandle(this, video, options.streamed && this.env.isWebKit());
  }

  /** The unmute gesture, for every handle that wants a route: the context resumed INSIDE it. */
  prime(): void {
    if (this.#wanting.size > 0) this.resumeInGesture();
  }

  /**
   * Makes the context if needed and calls `resume()` synchronously - inside the caller's gesture.
   *
   * WHAT IS WORTH WAITING FOR IS DECIDED FROM THE STATE, never from a clock (review of #3394): only a
   * `suspended` context's `resume()` is one the engine answers on its own, so only its settlement is
   * returned - a caller then starts its element once the route can be built AT its gain. Any other
   * state that is not `running` (WebKit's `interrupted` during a phone call, a context the engine
   * closed) may hold its `resume()` unanswered for as long as the cause lasts: the call is still made,
   * and `null` is returned with the state, so no caller waits on it. `null` and `running`: nothing was
   * asked, and the caller keeps its gesture's synchronous turn for `play()`.
   */
  resumeInGesture(): { resumed: Promise<void> | null; state: AudioContextState | null } {
    const ctx = this.context();
    if (!ctx || ctx.state === 'running') return { resumed: null, state: ctx?.state ?? null };
    const state = ctx.state;
    // NEVER A SILENT WAIT: a second gesture finding the first one's resume still unanswered is the
    // only evidence a `suspended` context will not come back, and it is said.
    if (state === 'suspended' && this.#waitedResume) {
      console.warn(
        "[LOUDNESS] a second gesture finds the AudioContext's resume() still unanswered " +
          '(suspended): the element still waits on it'
      );
      return { resumed: this.#waitedResume, state };
    }
    Log.d('LOUDNESS', `the reader's gesture resumes the shared AudioContext (${state})`);
    const resumed = ctx
      .resume()
      .catch((e: unknown) => {
        console.warn('[LOUDNESS] the gesture could not resume the AudioContext', e);
      })
      .finally(() => {
        if (this.#waitedResume === resumed) this.#waitedResume = null;
      });
    if (state !== 'suspended') return { resumed: null, state };
    this.#waitedResume = resumed;
    return { resumed, state };
  }

  /** The current context, made on first need; null where the engine has no Web Audio. */
  context(): AudioContext | null {
    if (this.#context || this.#unavailable) return this.#context;
    try {
      this.#context = this.env.createContext();
    } catch (e) {
      console.warn('[LOUDNESS] the shared AudioContext could not be made', e);
      this.#context = null;
    }
    if (!this.#context) {
      this.#unavailable = true;
      return null;
    }
    Log.d('LOUDNESS', `the shared AudioContext is made, ${this.#context.state}`);
    // IDLE ONLY (review of #3394): a routed element still playing - a note behind a web tab - keeps
    // its output; on native the arbiter has paused every media first, so this finds nothing playing.
    this.#unsubscribeScreen ??= this.env.onScreenChange((onScreen) => {
      if (!onScreen) this.suspendIfIdle('the app left the screen');
    });
    return this.#context;
  }

  /** Whether `ctx` is the live context (a closed one is never handed a new node). */
  isCurrent(ctx: AudioContext): boolean {
    return this.#context === ctx;
  }

  want(handle: RouteHandle, wants: boolean): void {
    if (wants) this.#wanting.add(handle);
    else this.#wanting.delete(handle);
  }

  routed(handle: RouteHandle): void {
    this.#routed.add(handle);
  }

  /** A routed element plays: the context is resumed; not running after it is a SILENT element. */
  playing(video: HTMLMediaElement): void {
    this.#playing.add(video);
    const ctx = this.#context;
    if (!ctx || ctx.state === 'running') return;
    Log.d('LOUDNESS', `a routed video plays, the context ${ctx.state}: resumed`);
    ctx.resume().then(
      () => {
        if (ctx.state !== 'running' && this.#playing.has(video)) {
          console.error(
            `[LOUDNESS] a video routed and SILENT: its AudioContext is ${ctx.state} after resume()`
          );
        }
      },
      (e: unknown) => {
        console.error('[LOUDNESS] a video routed and SILENT: its AudioContext refused resume()', e);
      }
    );
  }

  /** A routed element stopped playing: the output is suspended once none plays. */
  stopped(video: HTMLMediaElement, why: string): void {
    if (!this.#playing.delete(video)) return;
    this.suspendIfIdle(why);
  }

  /** A routed handle released: suspended if idle, CLOSED once no routed element is mounted. */
  released(handle: RouteHandle, video: HTMLMediaElement): void {
    this.#routed.delete(handle);
    this.#wanting.delete(handle);
    this.#playing.delete(video);
    const ctx = this.#context;
    if (!ctx) return;
    if (this.#routed.size > 0) {
      this.suspendIfIdle('a routed video unmounted');
      return;
    }
    Log.d('LOUDNESS', 'no routed video is mounted: the shared AudioContext is closed');
    this.#context = null;
    this.#unsubscribeScreen?.();
    this.#unsubscribeScreen = null;
    ctx.close().catch((e: unknown) => console.warn('[LOUDNESS] the AudioContext did not close', e));
  }

  /**
   * Suspends the running context when nothing routed plays - on a routed element's `pause`, `ended`
   * or unmount, and when the app leaves the screen. It never suspends under a routed element that
   * plays: on web and desktop a note the reader started keeps playing behind another tab (the
   * arbiter's rule); on a native phone the arbiter pauses every registered media first.
   */
  suspendIfIdle(why: string): void {
    const ctx = this.#context;
    if (!ctx || ctx.state !== 'running') return;
    if (this.#playing.size > 0) return;
    Log.d('LOUDNESS', `the shared AudioContext is suspended: ${why}`);
    ctx.suspend().catch((e: unknown) => console.warn('[LOUDNESS] suspend() failed', e));
  }
}

/** One element's wiring. */
class RouteHandle implements LoudnessHandle {
  #gainDb = 0;
  #measured = false;
  #gainNode: GainNode | null = null;
  #resumePending = false;
  #pendingSaid = false;
  #fellBack = false;
  #streamSaid = false;
  #disposed = false;
  readonly #ensure = () => this.#ensureRoute();
  readonly #onPlay = () => {
    if (this.#gainNode) this.audio.playing(this.video);
    else this.#ensureRoute();
  };
  readonly #onPause = () => this.audio.stopped(this.video, 'no routed video plays');
  readonly #onEnded = () => this.audio.stopped(this.video, 'a routed video ended');

  constructor(
    readonly audio: LoudnessAudio,
    readonly video: HTMLMediaElement,
    /** A MediaSource element on WebKit: never routed (see the module comment). */
    readonly webkitStream: boolean
  ) {
    video.addEventListener('volumechange', this.#ensure);
    video.addEventListener('play', this.#onPlay);
    video.addEventListener('pause', this.#onPause);
    video.addEventListener('ended', this.#onEnded);
  }

  setLoudness(loudness: MediaLoudness | null | undefined): void {
    if (this.#disposed) return;
    this.#gainDb = loudnessGainDb(loudness);
    this.#measured = isMediaLoudness(loudness);
    const factor = dbToGain(this.#gainDb);
    if (this.#gainNode) {
      this.#gainNode.gain.value = factor;
      Log.d('LOUDNESS', `gain now ${this.#describe()}`);
      return;
    }
    this.#undoFallback();
    if (this.#gainDb === 0) {
      this.audio.want(this, false);
      Log.d(
        'LOUDNESS',
        this.#measured
          ? 'measured within the dead band: played as is'
          : 'no measurement: played as is'
      );
      return;
    }
    if (this.webkitStream) {
      this.audio.want(this, false);
      if (!this.#streamSaid) {
        this.#streamSaid = true;
        console.warn(
          '[LOUDNESS] a stream on WebKit is not routed (MSE through Web Audio may play silent, ' +
            'owed an iPhone 12 reading)'
        );
      }
      this.#fallBack('a WebKit stream');
      return;
    }
    this.audio.want(this, true);
    this.#ensureRoute();
  }

  prime(): Promise<void> | null {
    // NOT GUARDED ON AN EXISTING GRAPH: a routed element whose context was suspended since (its
    // pause, another element's end) needs its `resume()` inside THIS tap as much as the first time.
    if (this.#disposed || this.#gainDb === 0 || this.webkitStream) return null;
    const { resumed, state } = this.audio.resumeInGesture();
    if (resumed || state === null || state === 'running') return resumed;
    // A CONTEXT NO GESTURE BRINGS BACK (`interrupted`, `closed`): the tap must still play. An element
    // not yet routed plays at once, unrouted, with the element-volume fallback for its gain - logged
    // at `warn` by `#fallBack`, a fallback being a signal. One already routed sounds only through the
    // graph (Web Audio's rule), so it is said: silent until the context runs again.
    if (this.#gainNode) {
      console.warn(
        `[LOUDNESS] a routed element is asked to play while its AudioContext is ${state}: ` +
          'silent until the context runs again'
      );
    } else {
      this.#fallBack(`the AudioContext is ${state}`);
    }
    return null;
  }

  destroy(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.video.removeEventListener('volumechange', this.#ensure);
    this.video.removeEventListener('play', this.#onPlay);
    this.video.removeEventListener('pause', this.#onPause);
    this.video.removeEventListener('ended', this.#onEnded);
    if (this.#gainNode) {
      routedSources.get(this.video)?.disconnect();
      this.#gainNode.disconnect();
      this.#gainNode = null;
      Log.d('LOUDNESS', 'nodes released');
    }
    this.audio.released(this, this.video);
    this.#undoFallback();
  }

  #describe(): string {
    return `${this.#gainDb >= 0 ? '+' : ''}${this.#gainDb.toFixed(1)} dB`;
  }

  /**
   * Builds the graph the first time the element is AUDIBLE - unmuted AND playing. A `resume()` still
   * unanswered when the element is audible again is said once: it plays, without its gain.
   */
  #ensureRoute(): void {
    if (this.#disposed || this.#gainNode || this.#fellBack || this.webkitStream) return;
    if (this.#gainDb === 0) return;
    // A muted element needs no context - muted autoplay must never ask for one.
    if (this.video.muted || this.video.paused) return;
    const ctx = this.audio.context();
    if (!ctx) {
      this.#fallBack('this engine has no Web Audio');
      return;
    }
    if (ctx.state === 'running') {
      this.#connect(ctx);
      return;
    }
    if (this.#resumePending) {
      if (!this.#pendingSaid) {
        this.#pendingSaid = true;
        console.warn(
          `[LOUDNESS] the AudioContext's resume() has not answered (${ctx.state}): the video plays` +
            ' unrouted, without its gain'
        );
      }
      void ctx.resume();
      return;
    }
    this.#resumePending = true;
    Log.d('LOUDNESS', `the shared AudioContext is ${ctx.state}: resumed`);
    ctx.resume().then(
      () => {
        this.#resumePending = false;
        if (this.#disposed || this.#gainNode || this.#fellBack) return;
        // READ AFTER the resume: a resolved promise is not a running context.
        if (ctx.state === 'running') this.#connect(ctx);
        else this.#fallBack(`the AudioContext stayed ${ctx.state}`);
      },
      (e: unknown) => {
        this.#resumePending = false;
        this.#fallBack(`the AudioContext refused to resume (${String(e)})`);
      }
    );
  }

  #connect(ctx: AudioContext): void {
    if (this.#gainNode) return;
    if (!this.audio.env.isArbitrated(this.video)) {
      console.error(
        `[LOUDNESS] a ${this.video.tagName.toLowerCase()} not registered with the playback arbiter` +
          ' is never routed: nothing would pause it, so nothing would release the output'
      );
      this.#fallBack('the element is not registered with the playback arbiter');
      return;
    }
    if (!this.audio.isCurrent(ctx)) {
      this.#fallBack('the AudioContext was closed meanwhile');
      return;
    }
    let source = routedSources.get(this.video);
    if (source && source.context !== ctx) {
      // Never reached by design (a context is closed only once no routed element is mounted).
      console.error(
        '[LOUDNESS] a video routed and SILENT: its source node belongs to a closed AudioContext'
      );
      return;
    }
    try {
      if (!source) {
        source = ctx.createMediaElementSource(this.video);
        routedSources.set(this.video, source);
      }
      const node = ctx.createGain();
      node.gain.value = dbToGain(this.#gainDb);
      source.connect(node);
      node.connect(ctx.destination);
      this.#gainNode = node;
    } catch (e) {
      this.#fallBack(`the engine refused the source node (${String(e)})`);
      return;
    }
    this.audio.routed(this);
    if (!this.video.paused) this.audio.playing(this.video);
    Log.d('LOUDNESS', `routed through Web Audio at ${this.#describe()}`);
  }

  /** The fallback, said for what it is. */
  #fallBack(cause: string): void {
    if (this.#fellBack || this.#disposed) return;
    this.#fellBack = true;
    this.audio.want(this, false);
    const factor = dbToGain(this.#gainDb);
    if (factor >= 1) {
      console.warn(
        `[LOUDNESS] FALLBACK: ${cause} - a raise of ${this.#describe()} cannot go through the` +
          ' element volume: played as is'
      );
      return;
    }
    const wanted = this.video.volume * factor;
    fallbackFactors.set(this.video, factor);
    this.video.volume = wanted;
    // iOS ignores a written volume (read-only, always 1): read back, never assumed.
    if (Math.abs(this.video.volume - wanted) > 1e-3) {
      fallbackFactors.delete(this.video);
      console.warn(
        `[LOUDNESS] FALLBACK: ${cause} - and this engine ignores the element volume: played as is`
      );
      return;
    }
    console.warn(
      `[LOUDNESS] FALLBACK: ${cause} - ${this.#describe()} applied through the element volume`
    );
  }

  /** Gives back the volume the fallback took, so a new measurement starts from the reader's level. */
  #undoFallback(): void {
    const applied = fallbackFactors.get(this.video);
    this.#fellBack = false;
    if (applied === undefined) return;
    fallbackFactors.delete(this.video);
    this.video.volume = Math.min(1, this.video.volume / applied);
  }
}

/** Whether this engine is WebKit (iOS, iPadOS, Safari, a WKWebView): every browser on iOS is. */
function engineIsWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android|Edg\//.test(ua);
}

/** The app's environment: the engine's own `AudioContext`. */
const appEnvironment: LoudnessEnvironment = {
  createContext() {
    if (typeof window === 'undefined') return null;
    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Ctor ? new Ctor() : null;
  },
  isWebKit: engineIsWebKit,
  isArbitrated: isArbitrated,
  onScreenChange: onAppScreenChange,
};

/** THE APP'S ONE loudness output. */
export const loudnessAudio = new LoudnessAudio(appEnvironment);

/**
 * The reader's unmute gesture, app-wide (`videoSound.setMuted(false)`): the context made and resumed
 * synchronously inside the gesture, when a mounted video has a gain to apply.
 */
export function primeLoudnessAudio(): void {
  loudnessAudio.prime();
}
