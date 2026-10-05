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

/** A line of text, in one colour. */
export interface ReelTextOverlay extends OverlayBase {
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

export type ReelOverlay = ReelTextOverlay | ReelEmojiOverlay;

let counter = 0;

/** A fresh overlay id, unique within the editor session. */
export function newOverlayId(): string {
  counter += 1;
  return `ov-${counter}`;
}

/** Where a new overlay lands: the middle of the frame, upright, at its base size. */
const CENTRED: Transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

/** A text overlay, or null for text that is empty once trimmed. */
export function createTextOverlay(text: string, color: string): ReelTextOverlay | null {
  const value = text.trim().slice(0, MAX_OVERLAY_TEXT_LENGTH);
  if (!value) return null;
  return { id: newOverlayId(), kind: 'text', text: value, color, ...CENTRED };
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

/** A text overlay recoloured or reworded; any other overlay is returned as is. */
export function withTextEdit(
  overlays: ReelOverlay[],
  id: string,
  edit: { text?: string; color?: string }
): ReelOverlay[] {
  return overlays.map((overlay) => {
    if (overlay.id !== id || overlay.kind !== 'text') return overlay;
    const text =
      edit.text === undefined ? overlay.text : edit.text.trim().slice(0, MAX_OVERLAY_TEXT_LENGTH);
    return { ...overlay, text: text || overlay.text, color: edit.color ?? overlay.color };
  });
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
