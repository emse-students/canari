import { containsEmoji, graphemes, isEmojiOnlyText } from './emoji';

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

describe('the grapheme split', () => {
  it('is lazy: a caller that stops early reads one grapheme of a long text', () => {
    const split = graphemes(`${'👍🏽'.repeat(10_000)}`);
    expect(split.next().value).toBe('👍🏽');
  });

  it('builds ONE segmenter for every call, never one per bubble', async () => {
    const Real = Intl.Segmenter;
    let built = 0;
    class Counting extends Real {
      constructor(...args: ConstructorParameters<typeof Real>) {
        super(...args);
        built += 1;
      }
    }
    vi.stubGlobal('Intl', { ...Intl, Segmenter: Counting });
    try {
      vi.resetModules();
      const fresh = await import('./emoji');
      for (const text of ['😀', 'banc ouverture 1', '👨‍👩‍👧‍👦', 'gg 😀', '🇫🇷🇫🇷']) {
        fresh.isEmojiOnlyText(text, 5);
      }
      expect(built).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers a long ordinary message the way a short one is answered', () => {
    expect(isEmojiOnlyText(`banc ouverture ${'x'.repeat(50_000)}`, 5)).toBe(false);
    expect(isEmojiOnlyText(`😀${'x'.repeat(50_000)}`, 5)).toBe(false);
    expect(isEmojiOnlyText('😀'.repeat(50_000), 5)).toBe(false);
  });
});
