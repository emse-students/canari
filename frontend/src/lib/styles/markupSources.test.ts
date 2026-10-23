/**
 * THE READER EVERY SOURCE-READING GATE SHARES, TESTED ON THE CASE THAT DECIDED ITS SHAPE.
 *
 * Seven files carried the same one-pass regex stripper, so one idiom produced repeated open CodeQL
 * alerts (`js/incomplete-multi-character-sanitization`). The rule's usual remedy - strip until the
 * string stops changing - is WRONG here, and this file is where that is pinned: HTML comments do
 * not nest, `<!-- a <!-- b --> c -->` ends at the first `-->`, and looping would delete content the
 * file really has.
 *
 * The last describe is the half the extraction was missing, and it is why the count above is seven
 * rather than three - it found two the sweep had left, and a seventh that landed while this very
 * branch was open.
 */
import { describe, it, expect } from 'vitest';
import { relativeTo, sourceFiles } from '../../test/sourceTree';
import { withoutAnyComments, withoutComments } from './markupSources';

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

describe('withoutAnyComments', () => {
  it('removes a line comment as well as the two block forms', () => {
    expect(withoutAnyComments('const a = 1; // why\n/* b */const c = 2;')).toBe(
      'const a = 1; \nconst c = 2;'
    );
  });

  it('leaves a URL alone, which is the exception the old regex was written around', () => {
    const source = "const u = 'https://canari-emse.fr/a';";
    expect(withoutAnyComments(source)).toBe(source);
  });

  it('leaves a `//` inside a string alone, which the old regex did NOT', () => {
    // `(^|[^:])//` states the exception instead of the rule, so it cut this line at the quote.
    const source = "const sep = 'a//b';";
    expect(withoutAnyComments(source)).toBe(source);
  });

  it('is a no-op on a source with no comments', () => {
    const source = 'if (e instanceof SocialApiError) return translate(e.code);';
    expect(withoutAnyComments(source)).toBe(source);
  });
});

/**
 * NO FILE KEEPS ITS OWN COMMENT STRIPPER, AND THAT IS THE PROPERTY, NOT A CONVENTION.
 *
 * Three high CodeQL alerts on 2026-09-09/10 were ONE idiom copied three times, and the module this
 * tests exists to end that. It did not: #504 added a FOURTH private copy in
 * `socialApiError.test.ts` on 2026-09-10 and reopened the same alert, because nothing was watching
 * - the extraction was the fix and an extraction nothing enforces is a suggestion.
 *
 * The rule is about the DELIMITER, not the spelling: any file that names `<!--` or an escaped
 * block-comment opener in a regex is stripping comments itself and must use this module instead.
 */
describe('the comment stripper has exactly one implementation', () => {
  const OWNER = 'lib/styles/markupSources.ts';
  const STRIPPER = /<!--|\\\*/;

  /** Every tracked `.ts` under `src`, which is where a private copy would be written. */
  const typescriptFiles = sourceFiles({ under: 'src', extensions: ['ts'], tests: 'include' });

  // Read through the module's own stripper, which is the honest way to write this rule: a file
  // may EXPLAIN the idiom in prose - this one does, at length - and only the code counts.
  const files = typescriptFiles.map(({ path, text }) => ({
    path: relativeTo(path, 'src'),
    body: withoutAnyComments(text),
  }));

  it('is reading the tree it thinks it is', () => {
    // A walk that found nothing would make the assertion below vacuously true, which is the one
    // way this guard could fail silently.
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => f.path)).toContain(OWNER);
    expect(files.map((f) => f.path)).toContain('lib/associations/socialApiError.test.ts');
  });

  it('no file strips comments itself (every offender listed)', () => {
    // ONE case for the rule, not one per file: the failure names every offender and its line (numbered in
    // the comment-stripped text). The idiom is a REMOVAL, so both halves are asserted together: a
    // line that names a comment delimiter and hands it to `replace` is stripping comments,
    // whatever it calls itself.
    const offenders = files
      .filter((f) => f.path !== OWNER)
      .flatMap((f) =>
        f.body
          .split('\n')
          .flatMap((line, i) =>
            line.includes('.replace(') && STRIPPER.test(line)
              ? [`${f.path}:${i + 1}: ${line.trim()}`]
              : []
          )
      );
    expect(offenders).toEqual([]);
  });
});
