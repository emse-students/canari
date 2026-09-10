/**
 * THE READER THE THREE STYLE GATES SHARE, TESTED ON THE CASE THAT DECIDED ITS SHAPE.
 *
 * The three gates each carried the same one-pass regex stripper, so one idiom produced three open
 * CodeQL alerts (`js/incomplete-multi-character-sanitization`). The rule's usual remedy - strip
 * until the string stops changing - is WRONG here, and this file is where that is pinned: HTML
 * comments do not nest, `<!-- a <!-- b --> c -->` ends at the first `-->`, and looping would
 * delete content the file really has.
 */
import { describe, it, expect } from 'vitest';
import { withoutComments } from './markupSources';

describe('withoutComments', () => {
  it('removes a plain markup comment', () => {
    expect(withoutComments('<p>a</p><!-- note --><p>b</p>')).toBe('<p>a</p><p>b</p>');
  });

  it('removes a block comment from a script', () => {
    expect(withoutComments('const a = 1; /* why */ const b = 2;')).toBe(
      'const a = 1;  const b = 2;'
    );
  });

  it('ends a comment at the FIRST close, because HTML comments do not nest', () => {
    // The whole reason the fixed-point loop this nearly shipped with would have been a defect:
    // ` c -->` is CONTENT, and a second pass looking for a delimiter would have eaten it.
    expect(withoutComments('x<!-- a <!-- b --> c -->y')).toBe('x c -->y');
  });

  it('leaves markup that only looks like a comment alone', () => {
    // An unterminated opener is not a comment and must not eat the rest of the file.
    expect(withoutComments('<p>a</p><!-- unterminated')).toBe('<p>a</p><!-- unterminated');
  });

  it('is a no-op on a source with no comments, rather than quietly rewriting it', () => {
    const source = '<button class="ui-icon-button rounded-xl"><Pen size={18} /></button>';
    expect(withoutComments(source)).toBe(source);
  });
});
