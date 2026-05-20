import { describe, expect, it } from 'vitest';
import { hasFormattedMarkdownPreview, parseInlineMarkdownPreview } from './inlinePreview';

function kinds(segments: ReturnType<typeof parseInlineMarkdownPreview>) {
  return segments.map((s) => s.kind);
}

describe('parseInlineMarkdownPreview', () => {
  it('parses closed italic with muted delimiters', () => {
    const segs = parseInlineMarkdownPreview('*test*');
    expect(kinds(segs)).toEqual(['delimiter', 'italic', 'delimiter']);
    expect(segs[1]).toMatchObject({ kind: 'italic', content: 'test' });
  });

  it('treats escaped asterisk as literal', () => {
    const segs = parseInlineMarkdownPreview('\\*');
    expect(segs).toEqual([{ kind: 'escape', char: '*' }]);
  });

  it('parses bold', () => {
    const segs = parseInlineMarkdownPreview('**bold**');
    expect(kinds(segs)).toEqual(['delimiter', 'bold', 'delimiter']);
  });

  it('parses strikethrough and inline code', () => {
    expect(kinds(parseInlineMarkdownPreview('~~x~~'))).toEqual([
      'delimiter',
      'strike',
      'delimiter',
    ]);
    expect(kinds(parseInlineMarkdownPreview('`c`'))).toEqual(['delimiter', 'code', 'delimiter']);
  });

  it('leaves unclosed delimiters as plain text', () => {
    expect(parseInlineMarkdownPreview('*open')).toEqual([{ kind: 'text', value: '*open' }]);
    expect(parseInlineMarkdownPreview('**bold')).toEqual([{ kind: 'text', value: '**bold' }]);
  });

  it('hasFormattedMarkdownPreview is false for lone asterisks', () => {
    expect(hasFormattedMarkdownPreview('*')).toBe(false);
    expect(hasFormattedMarkdownPreview('**')).toBe(false);
    expect(hasFormattedMarkdownPreview('*open')).toBe(false);
  });

  it('hasFormattedMarkdownPreview is true for closed spans', () => {
    expect(hasFormattedMarkdownPreview('*closed*')).toBe(true);
    expect(hasFormattedMarkdownPreview('**bold**')).toBe(true);
  });

  it('does not italicize after escaped opener', () => {
    const segs = parseInlineMarkdownPreview('\\*still*');
    expect(segs).toEqual([
      { kind: 'escape', char: '*' },
      { kind: 'text', value: 'still*' },
    ]);
  });
});
