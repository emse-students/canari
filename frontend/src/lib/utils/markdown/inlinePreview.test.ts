import { describe, expect, it } from 'vitest';
import {
  hasFormattedMarkdownPreview,
  markdownStructureKey,
  parseInlineMarkdownPreview,
} from './inlinePreview';

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

  it('parses italic with single underscores', () => {
    const segs = parseInlineMarkdownPreview('_test_');
    expect(kinds(segs)).toEqual(['delimiter', 'italic', 'delimiter']);
    expect(segs[1]).toMatchObject({ kind: 'italic', content: 'test', marker: '_' });
  });

  it('parses underline with double underscores', () => {
    const segs = parseInlineMarkdownPreview('__test__');
    expect(kinds(segs)).toEqual(['delimiter', 'underline', 'delimiter']);
    expect(segs[1]).toMatchObject({ kind: 'underline', content: 'test', marker: '__' });
  });

  it('keeps * / _ for italic and __ for underline', () => {
    const segs = parseInlineMarkdownPreview('*i* _j_ __u__');
    expect(kinds(segs)).toEqual([
      'delimiter',
      'italic',
      'delimiter',
      'text',
      'delimiter',
      'italic',
      'delimiter',
      'text',
      'delimiter',
      'underline',
      'delimiter',
    ]);
  });

  it('conflict solving', () => {
    const segs = parseInlineMarkdownPreview('** a*b **');
    expect(kinds(segs)).toEqual(['delimiter', 'bold', 'delimiter']);
    expect(segs[1]).toMatchObject({ kind: 'bold', content: ' a*b ' });
  });

  it('combination', () => {
    const segs = parseInlineMarkdownPreview('** a *b* c **');
    expect(kinds(segs)).toEqual([
      'delimiter',
      'bold',
      'delimiter',
      'italic',
      'delimiter',
      'bold',
      'delimiter',
    ]);
    expect(segs[1]).toMatchObject({ kind: 'bold', content: ' a ' });
    expect(segs[3]).toMatchObject({ kind: 'italic', content: 'b' });
    expect(segs[5]).toMatchObject({ kind: 'bold', content: ' c ' });
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

  it('markdownStructureKey is stable when editing inside formatted spans', () => {
    expect(markdownStructureKey('*test*')).toBe(markdownStructureKey('*tests*'));
    expect(markdownStructureKey('*test*')).not.toBe(markdownStructureKey('*test'));
  });

  it('does not italicize after escaped opener', () => {
    const segs = parseInlineMarkdownPreview('\\*still*');
    expect(segs).toEqual([
      { kind: 'escape', char: '*' },
      { kind: 'text', value: 'still*' },
    ]);
  });
});
