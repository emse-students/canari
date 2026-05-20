import { describe, expect, it } from 'vitest';
import { extractFirstUrl, isAngleBracketAutolink, splitTextWithLinks } from './messageDisplay';

describe('isAngleBracketAutolink', () => {
  it('detects <url> wrapper', () => {
    const text = 'voir <https://example.com> ici';
    const start = text.indexOf('https');
    const end = start + 'https://example.com'.length;
    expect(isAngleBracketAutolink(text, start, end)).toBe(true);
  });
});

describe('extractFirstUrl', () => {
  it('returns bare URLs', () => {
    expect(extractFirstUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  it('skips angle-bracket autolinks', () => {
    expect(extractFirstUrl('lien <https://example.com> fin')).toBe(null);
  });

  it('returns first bare URL when autolink precedes it', () => {
    expect(extractFirstUrl('<https://a.com> puis https://b.com')).toBe('https://b.com');
  });
});

describe('splitTextWithLinks', () => {
  it('marks autolink URLs with noEmbed', () => {
    const segments = splitTextWithLinks('x <https://example.com> y');
    const link = segments.find((s) => s.type === 'link');
    expect(link).toMatchObject({ value: 'https://example.com', noEmbed: true });
  });

  it('keeps normal links embeddable', () => {
    const segments = splitTextWithLinks('https://example.com');
    expect(segments).toContainEqual({ type: 'link', value: 'https://example.com' });
  });
});
