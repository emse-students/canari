import { Log } from '$lib/utils/Log';

/**
 * Measures how much the engine multiplies FONT sizes beyond LENGTHS, and publishes it on the root
 * as `--text-zoom` for `.text-zoom-exempt` in `app.css`.
 *
 * WHY A RATIO AND NOT THE ROOT FONT SIZE. Android's WebView applies the system text size to font
 * sizes only (measured on the Mi 9T at 200 %, 2026-09-30: root font 32px while a `1rem` box is
 * 16px wide), so text outgrows every box sized in `rem`. A desktop browser whose default font is
 * raised to 20px grows BOTH - a `1rem` box is then 20px too - and nothing overflows. Font size over
 * the width of a `1rem` box is 2 in the first case and 1 in the second, which is exactly the factor
 * a glyph confined to a fixed box (avatar initials) has to undo, and nothing else.
 *
 * Measured once at start-up: a change of the Android text size restarts the activity, which
 * reloads the page and measures again.
 *
 * @returns the published factor, 1 when nothing can be measured.
 */
export function publishTextZoom(doc: Document = document): number {
  const root = doc.documentElement;
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:1rem;height:0';
  doc.body.append(probe);
  const remBox = probe.getBoundingClientRect().width;
  probe.remove();
  const fontPx = parseFloat(getComputedStyle(root).fontSize);
  if (!(remBox > 0) || !(fontPx > 0)) {
    Log.d('textZoom: nothing to measure (no layout), --text-zoom left unset');
    return 1;
  }
  const zoom = Math.round((fontPx / remBox) * 100) / 100;
  root.style.setProperty('--text-zoom', String(zoom));
  Log.d(`textZoom: font ${fontPx}px over a ${remBox}px rem box -> --text-zoom ${zoom}`);
  return zoom;
}

/** The body size (px) iOS draws at the default "Large" Dynamic Type category: the scale's 1. */
export const IOS_DEFAULT_BODY_PX = 17;

/**
 * The most the type scale follows iOS. Android's 200 % is the largest scale every layout was read
 * at (rows, composer, nav, bubbles, agenda), so the accessibility sizes (body up to 53px, 3.1x)
 * stop there rather than outgrow a contract nobody measured.
 */
export const IOS_TYPE_SCALE_MAX = 2;

/**
 * Maps the size `font: -apple-system-body` resolves to onto the factor the `--text-*` tokens
 * multiply by. Never below 1: `--text-2xs` is the floor of the scale ("nothing goes below 12px"), so
 * the "Smaller" categories keep the default.
 *
 * @param bodyPx - the computed font size of a probe styled `-apple-system-body`.
 * @returns a factor in [1, IOS_TYPE_SCALE_MAX], 1 for anything unreadable.
 */
export function iosTypeScale(bodyPx: number): number {
  if (!Number.isFinite(bodyPx) || bodyPx <= 0) return 1;
  const raw = Math.round((bodyPx / IOS_DEFAULT_BODY_PX) * 100) / 100;
  return Math.min(IOS_TYPE_SCALE_MAX, Math.max(1, raw));
}

/**
 * Makes the type scale follow iOS Dynamic Type, the way Android's WebView follows its font scale:
 * font sizes grow, lengths stay. WKWebView ignores the setting for ordinary CSS, but a font declared
 * `-apple-system-body` resolves to the user's current body size, so a hidden probe reads it back -
 * no native bridge. Publishes `--type-scale` (multiplied into every `--text-*` token in `app.css`)
 * only: `--text-zoom` keeps meaning "the engine inflated every font" (1 on iOS), so a font the
 * engine does not inflate and the tokens do not size (the reel overlay) is not shrunk. `app.css`
 * divides avatar glyphs by BOTH factors.
 *
 * Call it again when the app comes back to the foreground: the setting changes outside the app.
 *
 * @returns the published factor.
 */
export function publishIosTypeScale(doc: Document = document): number {
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;height:0;font:-apple-system-body';
  doc.body.append(probe);
  const bodyPx = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  const scale = iosTypeScale(bodyPx);
  const root = doc.documentElement;
  root.style.setProperty('--type-scale', String(scale));
  Log.d(`textZoom: iOS body ${bodyPx}px -> --type-scale ${scale}`);
  return scale;
}

/**
 * Wires Dynamic Type for the platform that has it, and does NOTHING anywhere else. The gate is
 * load-bearing: Chromium rejects the `-apple-system-body` shorthand, so an ungated probe reads the
 * default 16px and would publish a 1 where Android needs its own factor untouched.
 *
 * Publishes now and again each time the app returns to the foreground (the setting is changed
 * outside the app and does not reload the page).
 *
 * @param isIos - true on the Tauri iOS runtime.
 * @returns the teardown (a no-op when the gate is shut).
 */
export function followIosDynamicType(isIos: boolean, doc: Document = document): () => void {
  if (!isIos) return () => {};
  publishIosTypeScale(doc);
  const onForeground = () => {
    if (doc.visibilityState === 'visible') publishIosTypeScale(doc);
  };
  doc.addEventListener('visibilitychange', onForeground);
  return () => doc.removeEventListener('visibilitychange', onForeground);
}
