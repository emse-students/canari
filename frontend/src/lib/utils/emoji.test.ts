import { containsEmoji, isEmojiOnlyText } from './emoji';

describe('containsEmoji', () => {
  it('finds a plain emoji among text', () => {
    expect(containsEmoji('bonjour 👋 les gens')).toBe(true);
  });

  it('finds a ZWJ family sequence', () => {
    expect(containsEmoji('salut 👨‍👩‍👧‍👦')).toBe(true);
  });

  it('finds a flag (regional indicator pair)', () => {
    expect(containsEmoji('vive la 🇫🇷')).toBe(true);
  });

  it('finds a skin-tone-modified emoji', () => {
    expect(containsEmoji('👍🏽 ok')).toBe(true);
  });

  it('is false for plain text', () => {
    expect(containsEmoji('bonjour les gens')).toBe(false);
  });

  it('is false for empty text', () => {
    expect(containsEmoji('')).toBe(false);
  });
});

describe('isEmojiOnlyText', () => {
  it('accepts a single plain emoji', () => {
    expect(isEmojiOnlyText('😀', 5)).toBe(true);
  });

  it('accepts a ZWJ family as one grapheme', () => {
    expect(isEmojiOnlyText('👨‍👩‍👧‍👦', 5)).toBe(true);
  });

  it('accepts a flag as one grapheme', () => {
    expect(isEmojiOnlyText('🇫🇷', 5)).toBe(true);
  });

  it('accepts a skin-tone modifier as one grapheme', () => {
    expect(isEmojiOnlyText('👍🏽', 5)).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(isEmojiOnlyText('  😀 😀  ', 5)).toBe(true);
  });

  it('rejects mixed text and emoji', () => {
    expect(isEmojiOnlyText('gg 😀', 5)).toBe(false);
  });

  it('rejects whitespace-only text', () => {
    expect(isEmojiOnlyText('   ', 5)).toBe(false);
  });

  it('rejects empty text', () => {
    expect(isEmojiOnlyText('', 5)).toBe(false);
  });

  it('accepts exactly the max count', () => {
    expect(isEmojiOnlyText('😀😀😀😀😀', 5)).toBe(true);
  });

  it('rejects one more than the max count', () => {
    expect(isEmojiOnlyText('😀😀😀😀😀😀', 5)).toBe(false);
  });
});
