import { isIosTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * ONE RECIPE FOR THE VIDEO PLAYER'S TRANSIENT PIECES, AND A BLUR ON TOP WHERE IT IS AFFORDABLE (owner,
 * 2026-11-15: "faux verre sans flou partout", then "small differences are acceptable when they give
 * each platform its best").
 *
 * The recipe (`.glass-video` in `app.css`) is FAKE GLASS: a translucent dark fill, a hairline, an inner
 * highlight and a shadow - the same shapes, sizes, icons and tokens on every platform. THE BLUR IS AN
 * ENHANCEMENT ON TOP OF THAT SAME RECIPE, iOS (WebKit) ONLY: `data-glass='blur'` adds `backdrop-filter`
 * and lowers the fill alpha a little so both looks read as one object.
 *
 * ANDROID IS NEVER BLURRED: the Mi 9T measured a 12 px blur over a playing 1080p clip at 98-99 % janky
 * frames against 38-44 % without (`docs/wiki/frontend/modules/video-player.md`, "the glass budget").
 * The iOS cost is a CHECK, not a gate, and is still owed there. A desktop browser stays on the base
 * recipe: it is not the platform whose best is being given.
 *
 * This is the ONE place that decides "blur available"; it reads a fact the device states, once, never
 * a frame time measured while it plays.
 */
export type VideoGlass = 'blur' | 'fake';

/** The facts the decision reads - a parameter, so a test states them without a device. */
export interface VideoGlassFacts {
  /** An iPhone or iPad: the app on iOS, or Safari / any browser there (all WebKit). */
  ios: boolean;
}

/** The decision itself, pure: blur on iOS, the base recipe everywhere else. */
export function decideVideoGlass(facts: VideoGlassFacts): VideoGlass {
  return facts.ios ? 'blur' : 'fake';
}

/** Reads the facts off this device. */
function readFacts(): VideoGlassFacts {
  if (typeof navigator === 'undefined') return { ios: false };
  const ua = navigator.userAgent;
  return { ios: isIosTauriRuntime() || /\b(iPhone|iPad|iPod)\b/.test(ua) };
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
