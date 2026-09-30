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
