import { settings } from '$lib/stores/settingsStore.svelte';
import { Log } from '$lib/utils/Log';
import { linkType } from './networkLink.svelte';

/**
 * "LECTURE AUTOMATIQUE DES VIDÉOS" ("Nos principes", owner 2026-11-10, principle 3: the reader decides
 * what the app spends of their attention and their data): whether a video IN THE FEED starts by
 * itself when it scrolls into view. A full-screen viewer (CanaReels, a lightbox, a live) is the
 * reader's own tap and plays whatever this says; a conversation's video never started by itself.
 *
 * - `always` (the default): as before, the video on screen plays.
 * - `wifi`: only when the device SAYS it is on Wi-Fi or Ethernet (`networkLink.svelte.ts`). OFFERED
 *   ONLY WHERE THE DEVICE CAN TELL (owner, 2026-11-11): only Chromium reports the link - the Android
 *   app, Chrome; iOS's WKWebView, Safari and Firefox do not, and there the choice is Toujours or
 *   Jamais. A `wifi` stored on such a device (chosen elsewhere, or before the link went unreported)
 *   behaves as `never` and is drawn as Jamais: an unknown link is never guessed to be Wi-Fi.
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

/** The Network Information API's link type, or null where the engine does not expose one. */
export function networkType(): string | null {
  return linkType();
}

/** Whether this engine says what link it is on at all - false on iOS, Safari and Firefox. */
export function networkTypeKnown(): boolean {
  return networkType() !== null;
}

/** The modes this device can honour - without `wifi` where it cannot tell its link. */
export function offeredVideoAutoplayModes(): readonly VideoAutoplayMode[] {
  return networkTypeKnown()
    ? VIDEO_AUTOPLAY_MODES
    : VIDEO_AUTOPLAY_MODES.filter((m) => m !== 'wifi');
}

/** Whether the "wifi read as never" line was already logged this session. */
let wifiUnknownLogged = false;

/**
 * This device's mode as it APPLIES: the stored choice, except a `wifi` on a device that cannot tell
 * its link, which is `never` (logged once at debug).
 */
export function videoAutoplayMode(): VideoAutoplayMode {
  const stored = parseVideoAutoplay(settings.videoAutoplay);
  if (stored !== 'wifi' || networkTypeKnown()) return stored;
  if (!wifiUnknownLogged) {
    wifiUnknownLogged = true;
    Log.d('VIDEO', 'autoplay: "wifi" stored on a device that reports no link - applied as never');
  }
  return 'never';
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
    Log.d('VIDEO', `autoplay: ${mode}, link ${type ?? 'unknown'} - the feed video waits for a tap`);
  }
  return allowed;
}
