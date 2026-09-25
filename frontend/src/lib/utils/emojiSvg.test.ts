import {
  EMOJI_SVG_BASE,
  emojiHtml,
  emojiSvgName,
  emojiSvgSrc,
  presentsAsEmoji,
  splitEmojiText,
} from './emojiSvg';

const at = (name: string) => `${EMOJI_SVG_BASE}${name}.svg`;

describe('emojiSvg', () => {
  it('serves the pictures under a content-hashed directory', () => {
    expect(EMOJI_SVG_BASE).toMatch(/^\/emoji\/[0-9a-f]{12}\/$/);
  });

  it('names a grapheme the way Noto names its file, without U+FE0F', () => {
    expect(emojiSvgName('😀')).toBe('1f600');
    expect(emojiSvgName('©️')).toBe('00a9');
    expect(emojiSvgName('#️⃣')).toBe('0023_20e3');
    expect(emojiSvgName('🇫🇷')).toBe('1f1eb_1f1f7');
    expect(emojiSvgName('👩🏽‍💻')).toBe('1f469_1f3fd_200d_1f4bb');
    expect(emojiSvgName('🏳️‍🌈')).toBe('1f3f3_200d_1f308');
  });

  it('keeps the characters that are really text as text: #, *, digits, ©, ®, ™', () => {
    for (const text of ['©', '®', '™', '0', '7', '#', '*']) {
      expect(presentsAsEmoji(text)).toBe(false);
      expect(emojiSvgSrc(text)).toBeNull();
    }
  });

  it('draws every other emoji even without U+FE0F, as keyboards and pastes often send them', () => {
    // U+1F4FD, reported by the user 2026-09-25: Unicode calls it text-default, every platform draws it.
    expect(emojiSvgSrc('\u{1F4FD}')).toBe(at('1f4fd'));
    expect(emojiSvgSrc('\u{1F4FD}\uFE0F')).toBe(at('1f4fd'));
    for (const [text, name] of [
      ['❤', '2764'],
      ['☺', '263a'],
      ['↔', '2194'],
      ['\u{1F576}', '1f576'],
    ] as const) {
      expect(emojiSvgSrc(text)).toBe(at(name));
    }
  });

  it('draws the emoji-presentation form of the same characters', () => {
    expect(emojiSvgSrc('©️')).toBe(at('00a9'));
    expect(emojiSvgSrc('❤️')).toBe(at('2764'));
    expect(emojiSvgSrc('#️⃣')).toBe(at('0023_20e3'));
  });

  it('draws flags, skin tones, ZWJ sequences and subdivision flags', () => {
    expect(emojiSvgSrc('🇫🇷')).toBe(at('1f1eb_1f1f7'));
    expect(emojiSvgSrc('👍🏿')).toBe(at('1f44d_1f3ff'));
    expect(emojiSvgSrc('👨‍👩‍👧‍👦')).toBe(at('1f468_200d_1f469_200d_1f467_200d_1f466'));
    expect(emojiSvgSrc('🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toBe(at('1f3f4_e0067_e0062_e0073_e0063_e0074_e007f'));
  });

  it('knows the newest emoji are emoji whatever the engine running it (Unicode 16, U+1FAEA)', () => {
    // Node's own tables miss this one; the rule must not ask them.
    expect(emojiSvgSrc(String.fromCodePoint(0x1faea))).toBe(at('1faea'));
  });

  it('draws a text-default base carrying a skin tone', () => {
    expect(emojiSvgSrc('☝🏽')).toBe(at('261d_1f3fd'));
  });

  it('leaves a sequence Noto does not draw as text rather than a broken image', () => {
    // A well-formed flag pair for a region that has no flag (ZZ).
    expect(presentsAsEmoji('🇿🇿')).toBe(true);
    expect(emojiSvgSrc('🇿🇿')).toBeNull();
  });

  it('merges text back into runs and splits each emoji out', () => {
    expect(splitEmojiText('bonjour à tous')).toEqual([{ kind: 'text', value: 'bonjour à tous' }]);
    expect(splitEmojiText('© 2026 😀!')).toEqual([
      { kind: 'text', value: '© 2026 ' },
      { kind: 'emoji', value: '😀', src: at('1f600') },
      { kind: 'text', value: '!' },
    ]);
    expect(splitEmojiText('🇫🇷🇫🇷')).toEqual([
      { kind: 'emoji', value: '🇫🇷', src: at('1f1eb_1f1f7') },
      { kind: 'emoji', value: '🇫🇷', src: at('1f1eb_1f1f7') },
    ]);
    expect(splitEmojiText('')).toEqual([]);
  });

  it('builds escaped HTML with emoji pictures, for the string-built exports', () => {
    const html = emojiHtml('<b>Soirée</b> & 🎉');
    expect(html).toContain('&lt;b&gt;Soirée&lt;/b&gt; &amp; ');
    expect(html).toContain(`<img class="emoji" src="${at('1f389')}" alt="🎉"`);
    expect(html).not.toContain('<b>');
    expect(emojiHtml('© 2026')).toBe('© 2026');
  });
});
