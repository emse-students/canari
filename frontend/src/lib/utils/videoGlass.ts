import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * WHETHER THE VIDEO PLAYER'S CONTROLS ARE BLURRED GLASS OR THE FLAT DARK CHIP (owner, 2026-11-09).
 *
 * `backdrop-filter` over a playing video has no published cost on an Android WebView - only bug
 * reports of stutter on Mali and older Adreno GPUs, scaling with the blurred area and the frame rate
 * (`docs/wiki/frontend/modules/video-player.md`). So the decision is taken from FACTS THE DEVICE
 * ALREADY KNOWS, once, never from a frame-time measured while it plays (no timer decides a look):
 *
 * - ANDROID IS FLAT UNTIL ITS MEASUREMENT (owner): {@link ANDROID_VIDEO_GLASS} is the one switch the
 *   Mi 9T reading flips (the protocol: video-player.md, "the glass budget"). Android means the app's
 *   WebView or a browser on Android - the same GPUs;
 * - once that switch is flipped, a LOW-END Android stays flat: `navigator.deviceMemory` <= 4 GB or
 *   `hardwareConcurrency` <= 4 cores. Only on Android: WebKit does not expose the memory and rounds
 *   the core count for privacy, so the same numbers would flatten an iPhone 12 for nothing - and no
 *   iPhone this app supports is low-end for a 12px blur;
 * - everything else (iOS, a desktop) is glass.
 *
 * The CSS fallbacks (`@supports not (backdrop-filter)`, `prefers-reduced-transparency`,
 * `prefers-contrast: more`) flatten it again in `app.css`, whatever this says.
 */
export type VideoGlass = 'glass' | 'flat';

/**
 * ANDROID'S DEFAULT - flat until the Mi 9T reading shows the blur costs no janky frames
 * (owner, 2026-11-09). Flipping it to `true` is the whole change once that reading passes.
 */
export const ANDROID_VIDEO_GLASS = false;

/** A device at or under this memory (GB, `navigator.deviceMemory`) gets the flat chip. */
export const LOW_END_MEMORY_GB = 4;

/** A device at or under this many logical cores gets the flat chip. */
export const LOW_END_CORES = 4;

/** The facts the decision reads - a parameter, so a test states them without a device. */
export interface VideoGlassFacts {
  android: boolean;
  /** `navigator.deviceMemory`, undefined where the engine does not expose it. */
  deviceMemoryGb?: number;
  /** `navigator.hardwareConcurrency`, undefined where the engine does not expose it. */
  cores?: number;
}

/** The decision itself, pure. */
export function decideVideoGlass(facts: VideoGlassFacts): VideoGlass {
  if (!facts.android) return 'glass';
  if (!ANDROID_VIDEO_GLASS) return 'flat';
  const lowMemory = facts.deviceMemoryGb !== undefined && facts.deviceMemoryGb <= LOW_END_MEMORY_GB;
  const fewCores = facts.cores !== undefined && facts.cores > 0 && facts.cores <= LOW_END_CORES;
  return lowMemory || fewCores ? 'flat' : 'glass';
}

/** Reads the facts off this device. */
function readFacts(): VideoGlassFacts {
  if (typeof navigator === 'undefined') return { android: false };
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    android: isAndroidTauriRuntime() || /\bAndroid\b/.test(nav.userAgent),
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
  };
}

let decided: VideoGlass | null = null;

/** This device's answer, decided at the first call and the same for the rest of the run. */
export function videoGlass(): VideoGlass {
  if (decided === null) {
    const facts = readFacts();
    decided = decideVideoGlass(facts);
    Log.d('VIDEO', { controls: decided, ...facts });
  }
  return decided;
}
