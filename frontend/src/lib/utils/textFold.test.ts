import { describe, it, expect } from 'vitest';
import { foldForSearch, foldWithIndex, slugify } from './textFold';

/**
 * The fold, and the one property seven hand-rolled copies could not have: an offset taken in folded
 * space that still means something in the original.
 *
 * A search that folds the QUERY and not the TEXT looks like it works - every unaccented query finds
 * every unaccented word - and fails only on the corpus this app actually carries. A highlighter
 * that folds both and then slices the ORIGINAL by a folded offset is worse: it draws over the wrong
 * characters, and only after an accent.
 *
 * NO DECOMPOSED SPELLING HERE IS TYPED. The two spellings of an accented letter are
 * indistinguishable in a source file, so a literal would leave a test asserting that a string
 * equals itself - and an editor or formatter normalising the file would do it silently. Every
 * decomposed case is BUILT with `normalize('NFD')` instead.
 */
describe('foldForSearch', () => {
  /**
   * The decomposed spelling, built rather than typed. `e` + U+0301 and the precomposed letter are
   * indistinguishable in a source file, so a literal would leave these tests asserting that a
   * string equals itself - and an editor or formatter normalising the file would do it silently.
   */
  const decomposed = (text: string) => text.normalize('NFD');
  it('makes an accented word findable by its unaccented spelling', () => {
    expect(foldForSearch('Réunion')).toBe(foldForSearch('reunion'));
    expect(foldForSearch('ÉLÈVE')).toBe('eleve');
    expect(foldForSearch('Ça va, où ça ?')).toBe('ca va, ou ca ?');
  });

  /** The same letter has two spellings in Unicode, and both must fold to the same thing. */
  it('folds a precomposed and a decomposed letter identically', () => {
    expect(foldForSearch('é')).toBe(foldForSearch(decomposed('é')));
    expect(foldForSearch('Réunion')).toBe(foldForSearch(decomposed('Réunion')));
  });

  it('leaves text with nothing to fold exactly as it was, but lower-cased', () => {
    expect(foldForSearch('Canari 2026')).toBe('canari 2026');
    expect(foldForSearch('')).toBe('');
  });
});

describe('foldWithIndex', () => {
  /**
   * THE FAILURE THE MAP EXISTS FOR. A precomposed letter is one character and its decomposition is
   * two, and folding drops the second. Any offset past an accent is therefore wrong in the original
   * by the number of accents before it - slicing by a folded index would start a character late.
   */
  it('maps a folded offset back to the character it came from', () => {
    const text = 'Réunion générale';
    const { folded, sourceIndex } = foldWithIndex(text);
    expect(folded).toBe('reunion generale');

    const at = folded.indexOf('generale');
    expect(text.slice(sourceIndex[at], sourceIndex[at + 'generale'.length])).toBe('générale');
  });

  /** A decomposed source is SHORTER after folding, which is the case a length assumption misses. */
  it('maps correctly when the original is already decomposed', () => {
    const text = 'Réunion'.normalize('NFD');
    const { folded, sourceIndex } = foldWithIndex(text);
    expect(folded).toBe('reunion');
    // `union` is at folded index 2, and at offset 3 in the original: R, e, U+0301.
    const at = folded.indexOf('union');
    expect(sourceIndex[at]).toBe(3);
    expect(text.slice(sourceIndex[at], sourceIndex[at + 'union'.length])).toBe('union');
  });

  /** The end sentinel: a match running to the last character needs an addressable end. */
  it('addresses a match that ends at the end of the string', () => {
    const text = 'café';
    const { folded, sourceIndex } = foldWithIndex(text);
    expect(sourceIndex[folded.length]).toBe(text.length);
    expect(text.slice(sourceIndex[0], sourceIndex[folded.length])).toBe(text);
  });

  /** An astral character is one unit, never two halves of a surrogate pair. */
  it('keeps an emoji whole', () => {
    const { folded, sourceIndex } = foldWithIndex('a\u{1F600}b');
    expect(folded).toBe('a\u{1F600}b');
    const at = folded.indexOf('b');
    expect(sourceIndex[at]).toBe(3);
  });

  it('says nothing about an empty string, and still addresses its end', () => {
    const { folded, sourceIndex } = foldWithIndex('');
    expect(folded).toBe('');
    expect(sourceIndex).toEqual([0]);
  });
});

describe('slugify', () => {
  it('produces the same slug for a name however it is accented', () => {
    expect(slugify('Bureau des Élèves')).toBe('bureau-des-eleves');
    expect(slugify('Bureau des Elèves')).toBe('bureau-des-eleves');
    expect(slugify('Bureau des Eleves')).toBe('bureau-des-eleves');
  });

  it('collapses runs of separators and trims the ends', () => {
    expect(slugify('  Les --- Canaris !!  ')).toBe('les-canaris');
    expect(slugify('a/b_c')).toBe('a-b-c');
  });

  /** A cut landing on a separator must not leave the trailing `-` the trim exists to remove. */
  it('truncates without leaving a trailing separator', () => {
    expect(slugify('Bureau des Eleves', 11)).toBe('bureau-des');
    expect(slugify('Bureau des Eleves', 10)).toBe('bureau-des');
    expect(slugify('Bureau des Eleves', 6)).toBe('bureau');
    expect(slugify('Bureau des Eleves')).toBe('bureau-des-eleves');
  });

  it('returns an empty slug rather than inventing one', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('')).toBe('');
  });
});
