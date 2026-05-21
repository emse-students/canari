import { describe, expect, it } from 'vitest';
import {
  hasFormattedMarkdownPreview,
  markdownStructureKey,
  parseInlineMarkdownPreview,
  type InlinePreviewSegment,
} from './inlinePreview';

function kinds(segments: InlinePreviewSegment[]) {
  return segments.map((s) => {
    if (s.kind === 'formatted') return `formatted:${s.styles.join('+')}`;
    return s.kind;
  });
}

function formattedContent(segments: InlinePreviewSegment[], index: number) {
  const seg = segments[index];
  expect(seg.kind).toBe('formatted');
  if (seg.kind !== 'formatted') return '';
  return seg.content;
}

describe('parseInlineMarkdownPreview', () => {
  it('parses closed italic with muted delimiters', () => {
    const segs = parseInlineMarkdownPreview('*test*');
    expect(kinds(segs)).toEqual(['delimiter', 'formatted:italic', 'delimiter']);
    expect(segs[1]).toMatchObject({ kind: 'formatted', styles: ['italic'], content: 'test' });
  });

  it('treats escaped asterisk as literal', () => {
    const segs = parseInlineMarkdownPreview('\\*');
    expect(segs).toEqual([{ kind: 'escape', char: '*' }]);
  });

  it('parses bold', () => {
    const segs = parseInlineMarkdownPreview('**bold**');
    expect(kinds(segs)).toEqual(['delimiter', 'formatted:bold', 'delimiter']);
  });

  it('parses italic with single underscores', () => {
    const segs = parseInlineMarkdownPreview('_test_');
    expect(kinds(segs)).toEqual(['delimiter', 'formatted:italic', 'delimiter']);
    expect(segs[1]).toMatchObject({
      kind: 'formatted',
      styles: ['italic'],
      content: 'test',
      marker: '_',
    });
  });

  it('parses underline with double underscores', () => {
    const segs = parseInlineMarkdownPreview('__test__');
    expect(kinds(segs)).toEqual(['delimiter', 'formatted:underline', 'delimiter']);
    expect(segs[1]).toMatchObject({
      kind: 'formatted',
      styles: ['underline'],
      content: 'test',
      marker: '__',
    });
  });

  it('keeps * / _ for italic and __ for underline', () => {
    const segs = parseInlineMarkdownPreview('*i* _j_ __u__');
    expect(kinds(segs)).toEqual([
      'delimiter',
      'formatted:italic',
      'delimiter',
      'text',
      'delimiter',
      'formatted:italic',
      'delimiter',
      'text',
      'delimiter',
      'formatted:underline',
      'delimiter',
    ]);
  });

  it('conflict solving', () => {
    const segs = parseInlineMarkdownPreview('** a*b **');
    expect(kinds(segs)).toEqual(['delimiter', 'formatted:bold', 'delimiter']);
    expect(segs[1]).toMatchObject({ kind: 'formatted', styles: ['bold'], content: ' a*b ' });
  });

  it('combines bold with nested italic', () => {
    const segs = parseInlineMarkdownPreview('** a *b* c **');
    expect(kinds(segs)).toEqual([
      'delimiter',
      'formatted:bold',
      'delimiter',
      'formatted:bold+italic',
      'delimiter',
      'formatted:bold',
      'delimiter',
    ]);
    expect(formattedContent(segs, 1)).toBe(' a ');
    expect(segs[3]).toMatchObject({ kind: 'formatted', styles: ['bold', 'italic'], content: 'b' });
    expect(formattedContent(segs, 5)).toBe(' c ');
  });

  it('combines strikethrough with italic', () => {
    const segs = parseInlineMarkdownPreview('~~*x*~~');
    expect(kinds(segs)).toEqual([
      'delimiter',
      'delimiter',
      'formatted:strike+italic',
      'delimiter',
      'delimiter',
    ]);
    expect(segs[2]).toMatchObject({
      kind: 'formatted',
      styles: ['strike', 'italic'],
      content: 'x',
    });
  });

  it('combines underline with italic and bold', () => {
    const segs = parseInlineMarkdownPreview('__*i*__');
    expect(segs[2]).toMatchObject({
      kind: 'formatted',
      styles: ['underline', 'italic'],
      content: 'i',
    });

    const underlineBold = parseInlineMarkdownPreview('__**bi**__');
    expect(underlineBold[2]).toMatchObject({
      kind: 'formatted',
      styles: ['underline', 'bold'],
      content: 'bi',
    });

    const allStyles = parseInlineMarkdownPreview('__***all***__');
    expect(allStyles[2]).toMatchObject({
      kind: 'formatted',
      styles: ['underline', 'bold', 'italic'],
      content: 'all',
    });
  });

  it('parses strikethrough and inline code', () => {
    expect(kinds(parseInlineMarkdownPreview('~~x~~'))).toEqual([
      'delimiter',
      'formatted:strike',
      'delimiter',
    ]);
    expect(kinds(parseInlineMarkdownPreview('`c`'))).toEqual(['delimiter', 'code', 'delimiter']);
  });

  it('does not parse markdown inside code', () => {
    const segs = parseInlineMarkdownPreview('`*not italic*`');
    expect(kinds(segs)).toEqual(['delimiter', 'code', 'delimiter']);
    expect(segs[1]).toMatchObject({ kind: 'code', content: '*not italic*' });
  });

  it('does not apply outer styles to code span content', () => {
    const segs = parseInlineMarkdownPreview('~~`x`~~');
    expect(segs.find((s) => s.kind === 'code')).toMatchObject({ content: 'x' });
    expect(segs.filter((s) => s.kind === 'formatted')).toHaveLength(0);
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
