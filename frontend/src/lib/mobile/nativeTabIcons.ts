import { mount, unmount, type Component } from 'svelte';
import { Log } from '$lib/utils/Log';

/**
 * The web bar's glyphs and accent, turned into what the native iOS tab bar takes (user, 2026-09-30:
 * "the same icons as the app, highlighted in yellow").
 *
 * The bar takes a bitmap per tab and a `#RRGGBB` tint. The glyphs are the Lucide components
 * `BottomNav` draws (`PLACE_ICONS`), rasterised here; the patched plugin renders them as TEMPLATES,
 * so only their alpha counts and the bar paints the selected one in the tint and the rest grey -
 * the colour drawn here is irrelevant. The tint is the web bar's own active class, resolved by the
 * browser, so it is the design token and not a copy of it.
 */

/** The bar's icon box, in points (`TabBarOverlay.imageSide`). */
const ICON_POINTS = 26;
/** Drawn at the densest screen iOS has, so no iPhone scales it up. */
const ICON_SCALE = 3;
/** The web bar's glyph size inside its own box, and its resting stroke. */
const GLYPH_SIZE = 24;
const GLYPH_STROKE = 2;

/**
 * One Lucide icon as a PNG data URL, drawn at {@link ICON_SCALE}x.
 *
 * Mounted to read the exact SVG the web draws, then rasterised through an `<img>` onto a canvas -
 * the plugin decodes bitmaps, not SVG.
 */
export async function lucideIconPng(icon: Component<Record<string, unknown>>): Promise<string> {
  const host = document.createElement('div');
  const app = mount(icon, { target: host, props: { size: GLYPH_SIZE, strokeWidth: GLYPH_STROKE } });
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
 * The web bar's active colour, as `#rrggbb`.
 *
 * Read from an element carrying the bar's own active classes, so the answer is whatever the design
 * tokens and the current theme make it - `amber-600`, or `amber-400` under `[data-theme='dark']` -
 * and then painted onto a 1px canvas, because the token is `oklch()` and only a pixel gives sRGB.
 */
export function activeTabTint(): string {
  const probe = document.createElement('span');
  probe.className = 'text-amber-600 dark:text-amber-400';
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
  Log.d('nativeTabIcons', `active tint ${color} -> ${hex}`);
  return hex;
}
