import { Log } from '$lib/utils/Log';

/**
 * ONE MEDIA PLAYS AT A TIME, IN THE WHOLE APP (user, 2026-10-02: *"commencer une video doit en
 * arreter une autre ... pareil pour l'audio, les vocaux, etc."* - #1341 had let several conversation
 * videos play together, which is a wall of sound).
 *
 * THE ONE REGISTRY. Every `<video>` and `<audio>` that can make sound registers on mount and
 * unregisters on destroy: a conversation's video, a voice note, an audio attachment, a post's or a
 * reel's video, the full-screen viewer. A registered element CLAIMS on its own `play` event - so a
 * native control, a programmatic `play()` and a button all claim alike - and every other element then
 * playing is PAUSED. Paused, never reset: it keeps its position, its own `pause` handler flips its
 * button back to "play", and no `ended` fires.
 *
 * AMBIENT ELEMENTS (the feed's muted looping videos, `playWhileVisible`) are the background: they
 * claim only against each other, and they YIELD to everything else - a foreground media that starts
 * pauses them, and one scrolling into view does not start while a foreground media plays
 * ({@link isForegroundPlaying}). They never steal playback back from what the reader chose; they pick
 * up again once the foreground goes quiet ({@link onPlaybackIdle}).
 *
 * WHAT IT DELIBERATELY DOES NOT DO: a refused `play()` raises no `play` event, so it claims nothing and
 * pauses nothing; a page going to the background pauses nothing new (no `visibilitychange` listener);
 * notification sounds and a call's streams are not registered, so they are untouched.
 */
export interface PlaybackOptions {
  /** Background playback (muted feed videos): yields to every foreground media. */
  ambient?: boolean;
}

const registry = new Map<HTMLMediaElement, { ambient: boolean }>();
const idleListeners = new Set<() => void>();

function isPlaying(el: HTMLMediaElement) {
  return !el.paused && !el.ended;
}

/** Whether a non-ambient registered media (other than `except`) is playing right now. */
export function isForegroundPlaying(except?: HTMLMediaElement): boolean {
  for (const [el, { ambient }] of registry) {
    if (el !== except && !ambient && isPlaying(el)) return true;
  }
  return false;
}

function isAnythingPlaying(): boolean {
  for (const el of registry.keys()) if (isPlaying(el)) return true;
  return false;
}

/**
 * Pauses every registered media playing but `except`, restricted to the ambient ones when
 * `ambientOnly`. Also what a recorder calls (without `except`): a microphone open next to a speaker
 * is feedback, and a clip with the previous one in it.
 */
export function pausePlayback(except?: HTMLMediaElement, ambientOnly = false, reason = 'claim') {
  for (const [el, { ambient }] of registry) {
    if (el === except || !isPlaying(el)) continue;
    if (ambientOnly && !ambient) continue;
    Log.d('VIDEO', `playback arbiter: pausing a ${el.tagName.toLowerCase()} (${reason})`);
    el.pause();
  }
}

/** `el` starts playing: it takes the app's one playback, or - if ambient - gives way. */
export function claimPlayback(el: HTMLMediaElement) {
  const entry = registry.get(el);
  if (!entry) return;
  if (entry.ambient) {
    if (isForegroundPlaying(el)) {
      // Raced a foreground media that started first: the background yields, it does not steal.
      Log.d(
        'VIDEO',
        'playback arbiter: an ambient video started under a foreground media, pausing it'
      );
      if (isPlaying(el)) el.pause();
      return;
    }
    pausePlayback(el, true, 'another ambient video took over');
    return;
  }
  pausePlayback(el, false, 'another media started');
}

/**
 * Subscribes to "nothing registered is playing any more" - after a pause, an end or an unmount. The
 * feed uses it to bring back the video on screen. Returns the unsubscribe.
 */
export function onPlaybackIdle(listener: () => void) {
  idleListeners.add(listener);
  return () => idleListeners.delete(listener);
}

function notifyIfIdle() {
  if (isAnythingPlaying()) return;
  for (const listener of idleListeners) listener();
}

/**
 * Registers a media element - a Svelte action (`use:arbitratePlayback`) or called directly.
 * Unregisters on `destroy`, so nothing outlives its element.
 */
export function arbitratePlayback(el: HTMLMediaElement, options: PlaybackOptions = {}) {
  registry.set(el, { ambient: options.ambient === true });
  const onPlay = () => claimPlayback(el);
  const onQuiet = () => notifyIfIdle();
  el.addEventListener('play', onPlay);
  el.addEventListener('pause', onQuiet);
  el.addEventListener('ended', onQuiet);
  return {
    destroy() {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onQuiet);
      el.removeEventListener('ended', onQuiet);
      registry.delete(el);
      notifyIfIdle();
    },
  };
}
