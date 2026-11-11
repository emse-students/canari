import { Log } from '$lib/utils/Log';
import { isMobileTauriRuntime } from '$lib/utils/appVersion';

/**
 * WHETHER THE APP'S VIDEOS MAKE SOUND - ONE ANSWER FOR ALL OF THEM (user, 2026-09-29).
 *
 * A video in the feed or in a reel plays by itself as soon as it is on screen, the way Instagram's
 * do, and whatever turns its sound on (a tap on the picture, the speaker button) turns it on for
 * every video in the app: a reader who wants to hear the feed should not have to ask once per post,
 * and the full-screen viewer follows the same answer, including when its own controls change it.
 *
 * REMEMBERED PER DEVICE (owner, 2026-11-09, replacing the session-only rule of 2026-09-29): the
 * reader's last choice survives the next video, the next session and a cold start - stored under
 * {@link VIDEO_SOUND_KEY}, a device preference like the theme (never per account, never wiped by a
 * sign-out). Two things the owner kept from the old rule:
 *
 * - THE FIRST EVER RUN IS SILENT: with nothing stored the answer is muted, until the reader unmutes
 *   once. Only {@link videoSound.setMuted} called from a reader's gesture writes the choice.
 * - UNMUTING IS ALWAYS A GESTURE. A stored "on" is honoured at start only where the engine lets a
 *   video start with sound without one - the phone apps, whose WebViews are configured so
 *   (`mediaPlaybackRequiresUserGesture = false`, WKWebView `mediaTypesRequiringUserActionForPlayback
 *   = []`). A browser refuses an audible autoplay before the page has had a gesture
 *   (`navigator.userActivation.hasBeenActive`), and a refused `play()` leaves the video STILL: so
 *   there, before any gesture, this session starts muted and the stored "on" is left as it is, for the
 *   next tap to restore. That is a fact read once at start, never a refusal provoked to learn it.
 *
 * NOT YET: following the device volume (a muted glyph at volume 0). A WebView does not expose the
 * system volume; it needs a native bridge on each phone - the owed work is in
 * `docs/wiki/backlog.d/video-sound-follows-the-device-volume.md`.
 */

/** The device preference's key: `'on'` or `'off'`; absent on a device that never chose. */
export const VIDEO_SOUND_KEY = 'canari-video-sound';

/** The device preference's key of the LEVEL (a number in (0, 1]); absent on a device that never set one. */
export const VIDEO_VOLUME_KEY = 'canari-video-volume';

/** The level of a device that never chose one: full, the element's own default. */
export const DEFAULT_VIDEO_LEVEL = 1;

/** Clamps to [0, 1]; a non-number is the default. Zero is MUTE, which never replaces the level. */
export function normalizeLevel(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_VIDEO_LEVEL;
  return Math.min(1, Math.max(0, raw));
}

function readStoredLevel(): number {
  try {
    const raw = localStorage.getItem(VIDEO_VOLUME_KEY);
    if (raw === null) return DEFAULT_VIDEO_LEVEL;
    const level = normalizeLevel(Number(raw));
    return level > 0 ? level : DEFAULT_VIDEO_LEVEL;
  } catch (err) {
    console.warn('[VIDEO] the volume level could not be read - starting at full', err);
    return DEFAULT_VIDEO_LEVEL;
  }
}

function writeStoredLevel(level: number): void {
  try {
    localStorage.setItem(VIDEO_VOLUME_KEY, String(level));
  } catch (err) {
    console.warn('[VIDEO] the volume level could not be saved', err);
  }
}

/** What the store remembers, or null when nothing (or something unreadable) is stored. */
function readStored(): 'on' | 'off' | null {
  try {
    const saved = localStorage.getItem(VIDEO_SOUND_KEY);
    return saved === 'on' || saved === 'off' ? saved : null;
  } catch (err) {
    console.warn('[VIDEO] the sound preference could not be read - starting muted', err);
    return null;
  }
}

function writeStored(value: 'on' | 'off'): void {
  try {
    localStorage.setItem(VIDEO_SOUND_KEY, value);
  } catch (err) {
    console.warn('[VIDEO] the sound preference could not be saved', err);
  }
}

/**
 * Whether a video may START with sound before this page has had a gesture: the phone apps' WebViews
 * may, a browser tab that has had no gesture yet may not.
 */
function engineAllowsAudibleStart(): boolean {
  if (isMobileTauriRuntime()) return true;
  const activation = (globalThis.navigator as Navigator | undefined)?.userActivation;
  return activation?.hasBeenActive === true;
}

/** The answer a run starts with: the stored choice, where the engine can honour it at once. */
export function initialVideoMuted(
  stored: 'on' | 'off' | null,
  audibleStartAllowed: boolean
): boolean {
  if (stored !== 'on') return true;
  return !audibleStartAllowed;
}

let muted = $state(
  typeof localStorage === 'undefined'
    ? true
    : initialVideoMuted(readStored(), engineAllowsAudibleStart())
);

/** The last NON-ZERO level: what an unmute restores and what the volume slider rests at. */
let level = $state(typeof localStorage === 'undefined' ? DEFAULT_VIDEO_LEVEL : readStoredLevel());

export const videoSound = {
  /** The app's one volume, in (0, 1], applied to every video's `volume`; mute is separate. */
  get level(): number {
    return level;
  },
  /**
   * Sets the LEVEL only (the desktop volume slider, owner 2026-11-11), remembered on this device.
   * Zero is not a level - it is mute - so the last non-zero one is kept and the caller mutes.
   */
  setLevel(next: number): void {
    const clamped = normalizeLevel(next);
    if (clamped <= 0 || clamped === level) return;
    Log.d('VIDEO', `volume level ${Math.round(clamped * 100)}% for every video`);
    level = clamped;
    writeStoredLevel(level);
  },
  /**
   * The slider's answer for EVERY video: dragging to 0 is mute (the level is kept), dragging up from
   * mute unmutes, anything else sets the level.
   */
  setVolume(next: number): void {
    const clamped = normalizeLevel(next);
    videoSound.setLevel(clamped);
    videoSound.setMuted(clamped <= 0);
  },
  /** True while every video in the app is silent. */
  get muted(): boolean {
    return muted;
  },
  /**
   * Sets the answer for every video and REMEMBERS it on this device - called from a reader's gesture
   * (a tap on a video, the speaker button, the `m` key, a viewer's own sound button). A no-op when it
   * is already that.
   */
  setMuted(next: boolean): void {
    if (next === muted) return;
    Log.d('VIDEO', `sound ${next ? 'off' : 'on'} for every video (remembered on this device)`);
    muted = next;
    writeStored(next ? 'off' : 'on');
  },
  /** Flips it - the speaker button's and the tap's action. */
  toggle(): void {
    videoSound.setMuted(!muted);
  },
  /**
   * THE ENGINE REFUSED AN AUDIBLE START and the caller plays muted instead (the live viewer, which
   * must not sit paused behind an autoplay rule): silent for THIS session, and NOT remembered - the
   * reader chose sound, the engine's refusal did not change that choice, and the next run (or the next
   * tap, through {@link videoSound.setMuted}) gets it back. Called BEFORE the element is muted, so the
   * `volumechange` a viewer forwards (`followVideoSound`) finds the answer already muted and writes
   * nothing.
   */
  muteForRefusedStart(): void {
    if (muted) return;
    console.info(
      '[VIDEO] an audible start was refused - silent for this session, the stored choice kept'
    );
    muted = true;
  },
};
