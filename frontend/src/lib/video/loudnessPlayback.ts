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
 * THE ROUTE ({@link attachLoudnessGain}): `MediaElementAudioSourceNode -> GainNode -> destination`
 * on ONE `AudioContext` for the whole app. What it must respect, each handled here:
 *
 * - **A context starts only after a gesture** (autoplay policy). A MUTED element never needs it: the
 *   graph is built the first time the element is AUDIBLE (unmuted and playing), which is the
 *   reader's tap or an audible start the engine already allowed - so muted autoplay never touches
 *   the context, and an audible one resumes it under the same permission. A context that will not
 *   run leaves the element UNROUTED (so it is never silenced) and takes the fallback below.
 * - **Once routed, an element sounds only through the graph** (Web Audio's rule). So it stays routed
 *   until it is unmounted; a later attach with no gain re-connects it at unity, and a `play` on a
 *   routed element resumes a context the system suspended in between.
 * - **`element.volume` and `muted` keep their meaning**: the engine applies both BEFORE the source
 *   node (Chromium, Firefox, WebKit), so the reader's mute silences the graph and the shared volume
 *   level (`videoSound.level`, PR #3372) multiplies with this gain. Nothing here writes them on the
 *   Web Audio route.
 * - **Blob and MSE sources**: a `blob:` URL and a `MediaSource` are same-origin, so the source node
 *   is never tainted into silence by CORS.
 * - **Unmount frees the nodes**: the source and the gain are disconnected, so the graph holds no
 *   element alive.
 *
 * THE FALLBACK, AND IT IS ONE: no Web Audio, a source node the engine refuses, or a context that does
 * not reach `running`. The element then gets the gain through `element.volume` when the gain LOWERS
 * (a volume cannot exceed 1) and the engine honours a written volume - iOS ignores it, which is read
 * back, not assumed. It is logged at `warn`, with its cause, once per element.
 */

import { Log } from '$lib/utils/Log';
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
  /** The app's one `AudioContext`, made on first use; null where the engine has no Web Audio. */
  audioContext(): AudioContext | null;
}

let sharedContext: AudioContext | null = null;
let sharedContextUnavailable = false;

/**
 * THE APP'S ONE `AudioContext` for video loudness, made on first need and never closed: a context
 * per video would hit the engine's cap (Chromium warns past a handful) and pay a device open each.
 */
function sharedAudioContext(): AudioContext | null {
  if (sharedContext || sharedContextUnavailable) return sharedContext;
  const Ctor =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) {
    sharedContextUnavailable = true;
    return null;
  }
  try {
    sharedContext = new Ctor();
    Log.d('LOUDNESS', `the shared AudioContext is made, ${sharedContext.state}`);
  } catch (e) {
    sharedContextUnavailable = true;
    console.warn('[LOUDNESS] the shared AudioContext could not be made', e);
  }
  return sharedContext;
}

const appEnvironment: LoudnessEnvironment = { audioContext: sharedAudioContext };

/**
 * Each element that has EVER been routed, with its source node: an element accepts one source node
 * in its life, and from then on sounds only through the graph.
 */
const routedSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

/** The factor the fallback put on an element's `volume`, so a level written later keeps it. */
const fallbackFactors = new WeakMap<HTMLMediaElement, number>();

/**
 * The `volume` an element should carry for the reader's `level` (0..1): the level itself, times the
 * loudness factor where the fallback route applied one. THE ONE PLACE a level reaches an element
 * that may be on the fallback - the shared volume level (PR #3372) writes through this, so it does
 * not erase the attenuation.
 */
export function elementVolumeFor(video: HTMLMediaElement, level: number): number {
  return Math.min(1, Math.max(0, level * (fallbackFactors.get(video) ?? 1)));
}

/**
 * Applies `loudness`'s gain to `video` for as long as the returned function is not called (the
 * player's unmount, or a new measurement for the same element).
 *
 * @returns The teardown: disconnects the nodes, or gives back the fallback's volume.
 */
export function attachLoudnessGain(
  video: HTMLMediaElement,
  loudness: MediaLoudness | null | undefined,
  env: LoudnessEnvironment = appEnvironment
): () => void {
  const gainDb = loudnessGainDb(loudness);
  const wasRouted = routedSources.has(video);
  if (gainDb === 0 && !wasRouted) {
    Log.d(
      'LOUDNESS',
      loudness ? 'measured within the dead band: played as is' : 'no measurement: played as is'
    );
    return () => {};
  }
  const factor = dbToGain(gainDb);
  let ctx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let fellBack = false;
  let disposed = false;

  const connect = (context: AudioContext) => {
    if (gainNode) return;
    try {
      let source = routedSources.get(video);
      if (!source) {
        source = context.createMediaElementSource(video);
        routedSources.set(video, source);
      }
      const node = context.createGain();
      node.gain.value = factor;
      source.connect(node);
      node.connect(context.destination);
      gainNode = node;
      Log.d(
        'LOUDNESS',
        `routed through Web Audio at ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB`
      );
    } catch (e) {
      fallBack(`the engine refused the source node (${String(e)})`);
    }
  };

  /** The fallback, said for what it is. */
  const fallBack = (cause: string) => {
    if (fellBack || disposed) return;
    fellBack = true;
    if (factor >= 1) {
      console.warn(
        `[LOUDNESS] FALLBACK: ${cause} - a raise of ${gainDb.toFixed(1)} dB cannot go through the` +
          ' element volume: played as is'
      );
      return;
    }
    const before = video.volume;
    fallbackFactors.set(video, factor);
    const wanted = before * factor;
    video.volume = wanted;
    // iOS ignores a written volume (read-only, always 1): read back, never assumed.
    if (Math.abs(video.volume - wanted) > 1e-3) {
      fallbackFactors.delete(video);
      console.warn(
        `[LOUDNESS] FALLBACK: ${cause} - and this engine ignores the element volume: played as is`
      );
      return;
    }
    console.warn(
      `[LOUDNESS] FALLBACK: ${cause} - ${gainDb.toFixed(1)} dB applied through the element volume`
    );
  };

  /**
   * Builds the graph the first time the element is AUDIBLE - unmuted AND playing, so the context is
   * asked for under the permission that let the sound start. A resume still pending is asked again
   * (idempotent); whichever answer comes first connects, once.
   */
  const ensure = () => {
    if (disposed || gainNode || fellBack) return;
    // A muted element needs no context - muted autoplay must never ask for one. An element routed
    // before is silent until re-connected, muted or not.
    if (!wasRouted && (video.muted || video.paused)) return;
    ctx ??= env.audioContext();
    if (!ctx) {
      fallBack('this engine has no Web Audio');
      return;
    }
    if (ctx.state === 'running') {
      connect(ctx);
      return;
    }
    const context = ctx;
    Log.d('LOUDNESS', `the shared AudioContext is ${context.state}: resumed`);
    context.resume().then(
      () => {
        if (disposed || gainNode || fellBack) return;
        if (context.state === 'running') connect(context);
        else fallBack(`the AudioContext stayed ${context.state}`);
      },
      (e: unknown) => fallBack(`the AudioContext refused to resume (${String(e)})`)
    );
  };

  /** A routed element plays only through the graph: a context the system suspended is resumed. */
  const onPlay = () => {
    if (gainNode && ctx && ctx.state !== 'running') {
      const context = ctx;
      Log.d('LOUDNESS', `play on a routed video, the context ${context.state}: resumed`);
      context.resume().catch((e: unknown) => {
        console.warn(
          `[LOUDNESS] a routed video plays SILENT: the context stays ${context.state}`,
          e
        );
      });
      return;
    }
    ensure();
  };

  video.addEventListener('volumechange', ensure);
  video.addEventListener('play', onPlay);
  ensure();

  return () => {
    disposed = true;
    video.removeEventListener('volumechange', ensure);
    video.removeEventListener('play', onPlay);
    if (gainNode) {
      routedSources.get(video)?.disconnect();
      gainNode.disconnect();
      gainNode = null;
      Log.d('LOUDNESS', 'nodes released');
    }
    const applied = fallbackFactors.get(video);
    if (applied !== undefined) {
      fallbackFactors.delete(video);
      video.volume = Math.min(1, video.volume / applied);
    }
  };
}
