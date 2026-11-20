/**
 * The page's ground under the keyboard's band, for the Android shell (`keyboardViewport`,
 * `postGroundToNative`; keyboard-and-send-motion.md). Pure apart from the colour conversion, which
 * needs a canvas and is passed in.
 */

/**
 * The first OPAQUE background from `start` up through its ancestors, as `#rrggbb`, or null. A glass
 * composer or a translucent panel is skipped: what shows through it is the ground below.
 */
export function groundOf(
  start: Element | null,
  backgroundOf: (el: Element) => string,
  toHex: (css: string) => string | null
): string | null {
  for (let el = start; el; el = el.parentElement) {
    const hex = toHex(backgroundOf(el));
    if (hex) return hex;
  }
  return null;
}

let probe: CanvasRenderingContext2D | null | undefined;

/** The colour the probe rests at between two conversions. */
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/**
 * Any CSS colour the engine computes (`rgb()`, `oklch()`, `color()`...) as `#rrggbb` when it is
 * fully opaque, else null - drawn on a one-pixel canvas, the engine's own conversion, so no colour
 * syntax is parsed here.
 */
export function cssColorToHex(css: string): string | null {
  if (!css || css === 'transparent') return null;
  if (probe === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext('2d', { willReadFrequently: true });
    if (probe) probe.fillStyle = TRANSPARENT;
  }
  if (!probe) return null;
  probe.clearRect(0, 0, 1, 1);
  // An unparsable value leaves `fillStyle` as it was, so the probe RESTS transparent between calls
  // (set at creation, restored after each draw): an unparsable value then reads as null, never as
  // the previous call's colour.
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  probe.fillStyle = TRANSPARENT;
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  if (a !== 255) return null;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
