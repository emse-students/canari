/**
 * THE OVERLAY MODEL OF THE CANAREELS EDITOR (docs/wiki/frontend/modules/reel-editor.md): the text and
 * the emoji a member places over a capture, as DATA. The editor renders it as DOM while the member
 * works and `reelEditor.ts` paints the very same data into the file, so what is on screen is what
 * is published - both read {@link overlayFontSize} / {@link EMOJI_BASE_SIZE}, never a number of
 * their own.
 *
 * Placement is a `Transform` (centre in 0..1 of the media frame, scale, rotation), the shape the
 * ONE gesture helper (`gestures/transformGesture.ts`) moves - an overlay kind never owns gesture
 * code.
 */
import type { Transform } from '$lib/gestures/transformGesture';

/** A text overlay's glyph height at scale 1, as a share of the frame's SHORT side. */
export const TEXT_BASE_SIZE = 0.07;
/** An emoji overlay's picture side at scale 1, as a share of the frame's SHORT side. */
export const EMOJI_BASE_SIZE = 0.2;
/** The bound on a text overlay: a caption, not a document. */
export const MAX_OVERLAY_TEXT_LENGTH = 80;

interface OverlayBase extends Transform {
  id: string;
}

/** The three typefaces of the text style row: the app's own, a serif and a monospace. */
export const TEXT_FONTS = ['sans', 'serif', 'mono'] as const;
export type ReelTextFont = (typeof TEXT_FONTS)[number];

/** The text sits on the picture as is, or on a pill filled with the chosen colour. */
export type ReelTextBackground = 'none' | 'pill';

/** What a new text starts with, and what the style row edits. */
export interface ReelTextStyle {
  font: ReelTextFont;
  background: ReelTextBackground;
}

/** The style a text starts with: the app's face, no pill. */
export const DEFAULT_TEXT_STYLE: ReelTextStyle = { font: 'sans', background: 'none' };

/** A line of text, in one colour, one typeface, on the picture or on a pill. */
export interface ReelTextOverlay extends OverlayBase, ReelTextStyle {
  kind: 'text';
  text: string;
  color: string;
}

/** One emoji, drawn as Noto's picture (`emojiSvgSrc`), never as the platform's glyph. */
export interface ReelEmojiOverlay extends OverlayBase {
  kind: 'emoji';
  /** The grapheme. */
  emoji: string;
}

/** A point of a stroke, in units of the frame's SHORT side, relative to the stroke's centre. */
export interface ReelStrokePoint {
  x: number;
  y: number;
}

/**
 * A freehand stroke, as an overlay so it moves, pinches, twists and is deleted like any other
 * (`reelStrokes.ts` builds it and owns its geometry). `width` is a share of the short side at
 * scale 1.
 */
export interface ReelStrokeOverlay extends OverlayBase {
  kind: 'stroke';
  color: string;
  width: number;
  points: ReelStrokePoint[];
}

export type ReelOverlay = ReelTextOverlay | ReelEmojiOverlay | ReelStrokeOverlay;

let counter = 0;

/** A fresh overlay id, unique within the editor session. */
export function newOverlayId(): string {
  counter += 1;
  return `ov-${counter}`;
}

/** Where a new overlay lands: the middle of the frame, upright, at its base size. */
const CENTRED: Transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

/** A text overlay, or null for text that is empty once trimmed. */
export function createTextOverlay(
  text: string,
  color: string,
  style: ReelTextStyle = DEFAULT_TEXT_STYLE
): ReelTextOverlay | null {
  const value = text.trim().slice(0, MAX_OVERLAY_TEXT_LENGTH);
  if (!value) return null;
  return { id: newOverlayId(), kind: 'text', text: value, color, ...style, ...CENTRED };
}

/** An emoji overlay. */
export function createEmojiOverlay(emoji: string): ReelEmojiOverlay {
  return { id: newOverlayId(), kind: 'emoji', emoji, ...CENTRED };
}

/** The overlays with `id` moved to `transform`; every other one is untouched (same reference). */
export function withTransform(
  overlays: ReelOverlay[],
  id: string,
  transform: Transform
): ReelOverlay[] {
  return overlays.map((overlay) => (overlay.id === id ? { ...overlay, ...transform } : overlay));
}

/** The overlays without `id`. */
export function withoutOverlay(overlays: ReelOverlay[], id: string): ReelOverlay[] {
  return overlays.filter((overlay) => overlay.id !== id);
}

/** `id` last, so it is drawn on top: the one being handled is never buried under another. */
export function broughtToFront(overlays: ReelOverlay[], id: string): ReelOverlay[] {
  const picked = overlays.find((overlay) => overlay.id === id);
  if (!picked || overlays[overlays.length - 1] === picked) return overlays;
  return [...withoutOverlay(overlays, id), picked];
}

/** A text overlay reworded, recoloured or restyled; any other overlay is returned as is. */
export function withTextEdit(
  overlays: ReelOverlay[],
  id: string,
  edit: { text?: string; color?: string; font?: ReelTextFont; background?: ReelTextBackground }
): ReelOverlay[] {
  return overlays.map((overlay) => {
    if (overlay.id !== id || overlay.kind !== 'text') return overlay;
    const text =
      edit.text === undefined ? overlay.text : edit.text.trim().slice(0, MAX_OVERLAY_TEXT_LENGTH);
    return {
      ...overlay,
      text: text || overlay.text,
      color: edit.color ?? overlay.color,
      font: edit.font ?? overlay.font,
      background: edit.background ?? overlay.background,
    };
  });
}

const FONT_STACKS: Record<Exclude<ReelTextFont, 'sans'>, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, Menlo, Consolas, monospace',
};

/** The CSS font-family of a typeface; `sans` is the app's own, passed in (the export reads it off the DOM). */
export function fontStack(font: ReelTextFont, appFamily: string): string {
  return font === 'sans' ? appFamily : FONT_STACKS[font];
}

/** Whether a `#rrggbb` colour is light enough that dark text reads on it. */
export function isLightColor(hex: string): boolean {
  const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!value) return false;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

/**
 * The two paints of a text: with a pill the CHOSEN colour fills the pill and the glyphs take the
 * contrasting ink (the Instagram behaviour), otherwise the colour is the glyphs on the bare picture.
 */
export function textPaint(overlay: Pick<ReelTextOverlay, 'color' | 'background'>): {
  fill: string;
  pill: string | null;
} {
  if (overlay.background !== 'pill') return { fill: overlay.color, pill: null };
  return { fill: isLightColor(overlay.color) ? '#050505' : '#ffffff', pill: overlay.color };
}

/** Line height, as a share of the font size: the preview's `line-height` and the pill's height. */
export const TEXT_LINE_HEIGHT = 1.2;
/** The pill's padding and corner, in em (shares of the font size), read by CSS `em` and by the export. */
export const PILL_PAD_X_EM = 0.5;
export const PILL_PAD_Y_EM = 0.2;
export const PILL_RADIUS_EM = 0.35;

/** The pill's size in px around a text `textWidth` px wide at `fontSize` px. */
export function pillSize(textWidth: number, fontSize: number) {
  return {
    width: textWidth + 2 * PILL_PAD_X_EM * fontSize,
    height: (TEXT_LINE_HEIGHT + 2 * PILL_PAD_Y_EM) * fontSize,
    radius: PILL_RADIUS_EM * fontSize,
  };
}

/**
 * A text overlay's font size in px for a frame of the given size, at `scale`. The ONE formula: the
 * export calls it with the media's size, the DOM preview expresses the same share in `cqmin`.
 */
export function overlayFontSize(width: number, height: number, scale = 1): number {
  return TEXT_BASE_SIZE * Math.min(width, height) * scale;
}

/** The emoji picture's side in px for a frame of the given size, at `scale`. */
export function emojiSize(width: number, height: number, scale = 1): number {
  return EMOJI_BASE_SIZE * Math.min(width, height) * scale;
}

/** The emoji offered as a first slice: the quick row of the tray (a full picker is a later package). */
export const QUICK_EMOJI = [
  '\u{1F600}',
  '\u{1F602}',
  '\u{1F60D}',
  '\u{1F525}',
  '❤️',
  '\u{1F44D}',
  '\u{1F389}',
  '\u{1F60E}',
  '\u{1F973}',
  '\u{1F62D}',
  '\u{1F64C}',
  '✨',
] as const;
