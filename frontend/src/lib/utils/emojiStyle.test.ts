// @vitest-environment happy-dom
/**
 * THE EMOJI SETTING (owner, 2026-11-09): the system font by default, Canari's pictures on demand,
 * applied by ONE module. These pin the vocabulary, the default every existing install falls into,
 * the storage, and what each mode hands the surfaces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMOJI_STYLES,
  currentEmojiStyle,
  emojiDisplayParts,
  emojiPictureSrc,
  parseEmojiStyle,
  setEmojiStyle,
} from './emojiStyle';
import { emojiSvgSrc, splitEmojiText } from './emojiSvg';

const KEY = 'canari_emoji_style';

afterEach(() => {
  setEmojiStyle('system');
  localStorage.removeItem(KEY);
});

describe('parseEmojiStyle', () => {
  it('is `system` for nothing stored - every install that predates the setting', () => {
    expect(parseEmojiStyle(null)).toBe('system');
    expect(parseEmojiStyle(undefined)).toBe('system');
  });

  it('is `system` for anything it does not know', () => {
    expect(parseEmojiStyle('')).toBe('system');
    expect(parseEmojiStyle('Canari')).toBe('system');
    expect(parseEmojiStyle('noto')).toBe('system');
  });

  it('keeps the two real values', () => {
    expect(parseEmojiStyle('system')).toBe('system');
    expect(parseEmojiStyle('canari')).toBe('canari');
  });

  it('lists system first, the default first', () => {
    expect(EMOJI_STYLES).toEqual(['system', 'canari']);
  });
});

describe('storage', () => {
  it('starts at `system` with nothing stored', () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(currentEmojiStyle()).toBe('system');
  });

  it('persists the choice per device, under its own key', () => {
    setEmojiStyle('canari');
    expect(currentEmojiStyle()).toBe('canari');
    expect(localStorage.getItem(KEY)).toBe('canari');
    setEmojiStyle('system');
    expect(localStorage.getItem(KEY)).toBe('system');
  });

  it('reads the stored value synchronously when the store loads, so the first paint knows it', async () => {
    localStorage.setItem(KEY, 'canari');
    vi.resetModules();
    const fresh = await import('./emojiStyle');
    expect(fresh.currentEmojiStyle()).toBe('canari');
  });
});

describe('system mode draws no picture', () => {
  it('hands back the whole text as one run, emoji included', () => {
    expect(emojiDisplayParts('salut 😀 et 🇫🇷 👍🏽', 'system')).toEqual([
      { kind: 'text', value: 'salut 😀 et 🇫🇷 👍🏽' },
    ]);
  });

  it('keeps a skin-toned emoji whole: the font draws the tone', () => {
    const [part] = emojiDisplayParts('👍🏽', 'system');
    expect(part.value).toBe('👍🏽');
  });

  it('has no source for any emoji, the default included', () => {
    expect(emojiPictureSrc('😀', 'system')).toBeNull();
    expect(emojiPictureSrc('😀')).toBeNull();
  });

  it('returns nothing for empty text', () => {
    expect(emojiDisplayParts('', 'system')).toEqual([]);
  });
});

describe('canari mode is exactly the picture rule', () => {
  it('splits as `splitEmojiText` does', () => {
    const text = 'salut 😀 et 🇫🇷 © 2026';
    expect(emojiDisplayParts(text, 'canari')).toEqual(splitEmojiText(text));
  });

  it('draws the picture `emojiSvgSrc` names', () => {
    expect(emojiPictureSrc('😀', 'canari')).toBe(emojiSvgSrc('😀'));
    expect(emojiPictureSrc('😀', 'canari')).not.toBeNull();
  });

  it('is what the default follows once chosen', () => {
    setEmojiStyle('canari');
    expect(emojiPictureSrc('😀')).toBe(emojiSvgSrc('😀'));
    expect(emojiDisplayParts('a 😀').some((p) => p.kind === 'emoji')).toBe(true);
  });
});
