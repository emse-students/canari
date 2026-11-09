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

/**
 * Replaces `Intl.Segmenter` (and nothing else of `Intl`) with a counting one, and loads a FRESH
 * `./emoji`, whose page-wide segmenter is built on first use: `built` counts constructions, `pulled`
 * the segments handed out through every iterator.
 */
async function withCountingSegmenter(
  run: (emoji: typeof import('./emoji'), counts: { built: number; pulled: number }) => void
): Promise<void> {
  const Real = Intl.Segmenter;
  const counts = { built: 0, pulled: 0 };
  class Counting extends Real {
    constructor(...args: ConstructorParameters<typeof Real>) {
      super(...args);
      counts.built += 1;
    }
    segment(input: string): Intl.Segments {
      const segments = super.segment(input);
      return {
        containing: (index?: number) => segments.containing(index),
        *[Symbol.iterator]() {
          for (const s of segments) {
            counts.pulled += 1;
            yield s;
          }
        },
      } as Intl.Segments;
    }
  }
  const own = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
  Object.defineProperty(Intl, 'Segmenter', { ...own, value: Counting });
  try {
    vi.resetModules();
    run(await import('./emoji'), counts);
  } finally {
    Object.defineProperty(Intl, 'Segmenter', own);
    vi.resetModules();
  }
}

describe('the grapheme split', () => {
  it('pulls segments only as they are read', async () => {
    await withCountingSegmenter(({ graphemes }, counts) => {
      const split = graphemes('👍🏽'.repeat(10_000));
      expect(split.next().value).toBe('👍🏽');
      expect(counts.pulled).toBe(1);
    });
  });

  it('stops at the first grapheme that is not an emoji, whatever the length', async () => {
    await withCountingSegmenter(({ isEmojiOnlyText }, counts) => {
      expect(isEmojiOnlyText(`banc ouverture 😀 ${'x'.repeat(50_000)}`, 5)).toBe(false);
      expect(counts.pulled).toBe(1);
      counts.pulled = 0;
      expect(isEmojiOnlyText(`😀😀${'x'.repeat(50_000)}`, 5)).toBe(false);
      expect(counts.pulled).toBe(3);
    });
  });

  it('builds no segmenter and pulls nothing for a text without a pictograph', async () => {
    await withCountingSegmenter(({ isEmojiOnlyText }, counts) => {
      expect(isEmojiOnlyText(`banc ouverture ${'x'.repeat(50_000)}`, 5)).toBe(false);
      expect(isEmojiOnlyText('1234 #*', 5)).toBe(false);
      expect(counts.built).toBe(0);
      expect(counts.pulled).toBe(0);
    });
  });

  it('stops at the grapheme past maxCount', async () => {
    await withCountingSegmenter(({ isEmojiOnlyText }, counts) => {
      expect(isEmojiOnlyText('😀'.repeat(50_000), 5)).toBe(false);
      expect(counts.pulled).toBe(6);
    });
  });

  it('builds ONE segmenter for every call, never one per bubble', async () => {
    await withCountingSegmenter(({ isEmojiOnlyText }, counts) => {
      for (const text of ['😀', 'banc ouverture 1', '👨‍👩‍👧‍👦', 'gg 😀', '🇫🇷🇫🇷']) {
        isEmojiOnlyText(text, 5);
      }
      expect(counts.built).toBe(1);
    });
  });

  it('leaves the rest of Intl alone while it counts', async () => {
    await withCountingSegmenter(() => {
      expect(new Intl.DateTimeFormat('en-US').format(new Date(2026, 0, 2))).toBe('1/2/2026');
      expect(typeof Intl.getCanonicalLocales).toBe('function');
    });
    expect(Intl.Segmenter.name).not.toBe('Counting');
  });
});

describe('isEmojiOnlyText at the count boundary, multi-code-point graphemes', () => {
  const family = '👨‍👩‍👧‍👦';
  const flag = '🇫🇷';
  const keycap = '1️⃣';

  it('counts a ZWJ family as one: five pass, six do not', () => {
    expect(isEmojiOnlyText(family.repeat(5), 5)).toBe(true);
    expect(isEmojiOnlyText(family.repeat(6), 5)).toBe(false);
  });

  it('counts a flag as one: five pass, six do not', () => {
    expect(isEmojiOnlyText(flag.repeat(5), 5)).toBe(true);
    expect(isEmojiOnlyText(flag.repeat(6), 5)).toBe(false);
  });

  it('never counts a keycap: neither Extended_Pictographic nor a regional indicator (unchanged rule)', () => {
    expect(isEmojiOnlyText(keycap, 5)).toBe(false);
    expect(isEmojiOnlyText(keycap.repeat(5), 5)).toBe(false);
    expect(isEmojiOnlyText(keycap.repeat(6), 5)).toBe(false);
  });
});
