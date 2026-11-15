import { describe, expect, it } from 'vitest';
import { codeBlockLines, codeRanges, insideCode } from './markdownCode';

describe('codeBlockLines - fences', () => {
  it('does not open a block on a backtick run whose info string holds a backtick', () => {
    // "```x``` voir" is a line of text with a code span, not a fence swallowing the rest.
    expect(codeBlockLines('```x``` voir\nhttps://a.example')).toEqual([false, false]);
  });

  it('opens a backtick fence with a plain info string, and a tilde fence with a backtick in it', () => {
    expect(codeBlockLines('```js\nx\n```')).toEqual([true, true, true]);
    expect(codeBlockLines('~~~ a`b\nx\n~~~')).toEqual([true, true, true]);
  });

  it('closes only on fence characters and white space', () => {
    // "``` not a closer" is content of the block; the bare fence after it closes it.
    expect(codeBlockLines('```\nx\n``` not a closer\ny\n```  \nafter')).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('codeBlockLines - indented code and lists (CommonMark)', () => {
  it('reads four columns under a list item as the item continuing, not code', () => {
    expect(codeBlockLines('- item\n\n    https://a.example')).toEqual([false, false, false]);
    expect(codeBlockLines('1. item\n\n    https://a.example')).toEqual([false, false, false]);
  });

  it('reads four columns past the item content as code', () => {
    expect(codeBlockLines('- item\n\n      https://a.example')).toEqual([false, false, true]);
  });

  it('ends the list at a paragraph left of the item content, then reads four columns as code', () => {
    expect(codeBlockLines('- item\n\nTexte\n\n    https://a.example')).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('reads four columns after a plain paragraph and a blank line as code', () => {
    expect(codeBlockLines('Texte\n\n    https://a.example')).toEqual([false, false, true]);
    expect(codeBlockLines('Texte\n    https://a.example')).toEqual([false, false]);
  });
});

describe('codeRanges', () => {
  it('covers an inline span, never its neighbours', () => {
    const text = 'a `b` c';
    const ranges = codeRanges(text);
    expect(insideCode(ranges, text.indexOf('b'))).toBe(true);
    expect(insideCode(ranges, text.indexOf('c'))).toBe(false);
  });
});
