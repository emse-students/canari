import { settings } from '$lib/stores/settingsStore.svelte';
import { Log } from '$lib/utils/Log';

/**
 * "LECTURE AUTOMATIQUE DES VIDÉOS" ("Nos principes", owner 2026-11-10, principle 3: the reader decides
 * what the app spends of their attention and their data): whether a video IN THE FEED starts by
 * itself when it scrolls into view. A full-screen viewer (CanaReels, a lightbox, a live) is the
 * reader's own tap and plays whatever this says; a conversation's video never started by itself.
 *
 * - `always` (the default): as before, the video on screen plays.
 * - `wifi`: only when the device SAYS it is on Wi-Fi or Ethernet (`navigator.connection.type`, the
 *   Network Information API). Only Chromium exposes that type - the Android app, Chrome; iOS's
 *   WKWebView, Safari and Firefox do not, and no Tauri plugin here reports the link. AN UNKNOWN LINK
 *   IS NOT WI-FI: the setting promises not to spend mobile data, and a guess could break that
 *   promise, so on such a device `wifi` behaves as `never` - and the Settings hint says so on that
 *   device ({@link networkTypeKnown}).
 * - `never`: the first frame and the play button; a tap plays it.
 */
export type VideoAutoplayMode = 'always' | 'wifi' | 'never';

/** Every mode, in the order the Settings choice draws them. */
export const VIDEO_AUTOPLAY_MODES: readonly VideoAutoplayMode[] = ['always', 'wifi', 'never'];

/** The answer of a device that never chose. */
export const DEFAULT_VIDEO_AUTOPLAY: VideoAutoplayMode = 'always';

/** A stored value narrowed to a mode; anything else (nothing stored, an old value) is the default. */
export function parseVideoAutoplay(value: string | null | undefined): VideoAutoplayMode {
  return VIDEO_AUTOPLAY_MODES.includes(value as VideoAutoplayMode)
    ? (value as VideoAutoplayMode)
    : DEFAULT_VIDEO_AUTOPLAY;
}

/** This device's chosen mode. */
export function videoAutoplayMode(): VideoAutoplayMode {
  return parseVideoAutoplay(settings.videoAutoplay);
}

/** The Network Information API's link type, or null where the engine does not expose one. */
export function networkType(): string | null {
  if (typeof navigator === 'undefined') return null;
  const connection = (navigator as Navigator & { connection?: { type?: unknown } }).connection;
  return typeof connection?.type === 'string' ? connection.type : null;
}

/** Whether this engine says what link it is on at all - false on iOS, Safari and Firefox. */
export function networkTypeKnown(): boolean {
  return networkType() !== null;
}

/** The link types `wifi` counts as not spending mobile data. */
const UNMETERED_LINKS = new Set(['wifi', 'ethernet']);

/**
 * Whether the feed may start a video by itself now, from the mode and the link - no log, so the
 * player's template may read it on every redraw (its play button is drawn when this is false).
 */
export function feedAutoplayPermitted(
  mode: VideoAutoplayMode = videoAutoplayMode(),
  type: string | null = networkType()
): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return type !== null && UNMETERED_LINKS.has(type);
}

/**
 * {@link feedAutoplayPermitted}, asked at each ambient start (`playWhileVisible`) and logged when it
 * says no - so a link that changes is followed at the next video, and a feed that stays still says why.
 */
export function feedAutoplayAllowed(): boolean {
  const mode = videoAutoplayMode();
  const type = networkType();
  const allowed = feedAutoplayPermitted(mode, type);
  if (!allowed) {
    Log.d(
      'VIDEO',
      `autoplay: ${mode}, link ${type ?? 'unknown (not reported by this engine)'} - the feed video waits for a tap`
    );
  }
  return allowed;
}
