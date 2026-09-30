import { mount, unmount, type Component } from 'svelte';
import { Log } from '$lib/utils/Log';

/**
 * The web bar's glyphs, turned into what the native iOS tab bar takes (user, 2026-09-30: "the same
 * icons as the app", then "yellow when selected, black when not, the bar itself not tinted").
 *
 * Each tab gets TWO bitmaps, already coloured, and the patched plugin draws both as they are
 * (`image` and `selectedImage`, `.alwaysOriginal`) - so no `tintColor` is set anywhere, which is
 * what kept the bar's glass untinted. The glyphs are the Lucide components `BottomNav` draws
 * (`PLACE_ICONS`); the colours are the web's own classes (`TAB_ICON_CLASSES`), resolved by the
 * browser for the current theme, so they are the design tokens and not copies of them.
 */

/**
 * The two states' colours, as the web writes them. "Black" at rest is the theme's TEXT colour -
 * near-black in light, near-white in dark, where black would vanish on the bar.
 */
export const TAB_ICON_CLASSES = {
  normal: 'text-text-main',
  selected: 'text-amber-600 dark:text-amber-400',
} as const;

/** The bar's icon box, in points (`TabBarOverlay.imageSide`). */
const ICON_POINTS = 26;
/** Drawn at the densest screen iOS has, so no iPhone scales it up. */
const ICON_SCALE = 3;
/** The web bar's glyph size inside its own box, and its resting stroke. */
const GLYPH_SIZE = 24;
const GLYPH_STROKE = 2;

/**
 * One Lucide icon as a PNG data URL in `colorHex`, drawn at {@link ICON_SCALE}x.
 *
 * Mounted to read the exact SVG the web draws, then rasterised through an `<img>` onto a canvas -
 * the plugin decodes bitmaps, not SVG. The colour is a hex, never the token's `oklch()`, because an
 * SVG loaded as an image is parsed on its own and the hex is what every engine reads.
 */
export async function lucideIconPng(
  icon: Component<Record<string, unknown>>,
  colorHex: string
): Promise<string> {
  const host = document.createElement('div');
  const app = mount(icon, {
    target: host,
    props: { size: GLYPH_SIZE, strokeWidth: GLYPH_STROKE, color: colorHex },
  });
  const svg = host.innerHTML;
  void unmount(app);

  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();

  const side = ICON_POINTS * ICON_SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas to rasterise a tab icon');
  // The glyph keeps the web bar's proportions: 24 of the box's 26 points, centred.
  const glyph = GLYPH_SIZE * ICON_SCALE;
  const inset = (side - glyph) / 2;
  ctx.drawImage(image, inset, inset, glyph, glyph);
  return canvas.toDataURL('image/png');
}

/** `#rrggbb` for 8-bit channels - the form the plugin's tint parser reads. */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The colour a class list gives text right now, as `#rrggbb`.
 *
 * Read from a probe element carrying the classes, so the answer is whatever the design tokens and
 * the current theme make it - `amber-600`, or `amber-400` under `[data-theme='dark']` - and then
 * painted onto a 1px canvas, because a token may be `oklch()` and only a pixel gives sRGB.
 */
export function classColorHex(className: string): string {
  const probe = document.createElement('span');
  probe.className = className;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas to resolve the tab tint');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = rgbToHex(r, g, b);
  Log.d('nativeTabIcons', `${className}: ${color} -> ${hex}`);
  return hex;
}
