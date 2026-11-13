/**
 * THE ONE PLACE THE EMOJI SETTING IS APPLIED (owner, 2026-11-09: *"choisir entre les emojis systeme
 * et les emojis Canari (emoji systeme par defaut)"*).
 *
 * - `system` (the DEFAULT, also for every install that predates the setting): the device's own emoji
 *   font draws every emoji. No picture is fetched, decoded or drawn, and no text is segmented.
 * - `canari`: Noto's pictures from `/emoji/`, exactly as `emojiSvg.ts` draws them.
 *
 * Every surface the user's choice governs asks THIS module (`emojiDisplayParts`, `emojiPictureSrc`),
 * never `emojiSvg.ts` directly: message text and everything else `EmojiText` prints, the composer's
 * atoms, the picker's cells and tab icons, the picker warm-up. `emojiSvg.ts` stays the pure picture
 * rule, which the build gate and the picker's coverage filter need whatever the setting says.
 *
 * NOT GOVERNED, ON PURPOSE - ARTEFACTS OTHER PEOPLE SEE: the PDF exports (poster, calendar,
 * trombinoscope) and the emoji burnt into a CanaReel keep the pictures, so what is printed or shared
 * is the same on every device and goes through the rasterisation path that was measured. See
 * `docs/wiki/frontend/emoji.md`.
 */
import { settings } from '$lib/stores/settingsStore.svelte';
import { emojiSvgSrc, splitEmojiText, type EmojiTextPart } from './emojiSvg';

/** How emoji are drawn: the platform's font, or Canari's own pictures. */
export type EmojiStyle = 'system' | 'canari';

/** Both choices, in the order the settings show them. */
export const EMOJI_STYLES: readonly EmojiStyle[] = ['system', 'canari'];

/**
 * Narrows a stored value: anything but `canari` - nothing stored, a hand edit, a value a later build
 * wrote - is the default, `system`.
 */
export function parseEmojiStyle(raw: string | null | undefined): EmojiStyle {
  return raw === 'canari' ? 'canari' : 'system';
}

/** The current choice. A `$state` read underneath, so a template that calls this re-renders on change. */
export function currentEmojiStyle(): EmojiStyle {
  return parseEmojiStyle(settings.emojiStyle);
}

/** Records a new choice; every governed surface follows on its next render. */
export function setEmojiStyle(style: EmojiStyle): void {
  console.debug(`[EMOJI] style -> ${style}`);
  settings.setEmojiStyle(style);
}

/** The picture to draw for `grapheme` under `style`, or `null` when the platform draws it. */
export function emojiPictureSrc(
  grapheme: string,
  style: EmojiStyle = currentEmojiStyle()
): string | null {
  return style === 'canari' ? emojiSvgSrc(grapheme) : null;
}

/**
 * `text` split into text runs and emoji pictures under `style`. In `system` mode the whole text is
 * one text run - the font draws its emoji, and the grapheme split is never paid.
 */
export function emojiDisplayParts(
  text: string,
  style: EmojiStyle = currentEmojiStyle()
): EmojiTextPart[] {
  if (style === 'canari') return splitEmojiText(text);
  return text ? [{ kind: 'text', value: text }] : [];
}
