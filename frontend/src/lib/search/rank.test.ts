import { describe, expect, it } from 'vitest';
import { containsEveryToken, foldQuery, matchTier, rankByLabels } from './rank';

/**
 * The ranking every on-device section of the universal search shares. The contract's ladder itself
 * (a transposition is one edit, the rungs at 4 and 8) is pinned once, in `utils/tolerantSearch.test.ts`;
 * this pins the tiers a list of names adds on top of it - and that every typed word must match.
 */
describe('matchTier', () => {
  const q = (s: string) => foldQuery(s);

  it('orders whole, prefix, word prefix, substring, typo', () => {
    expect(matchTier('Gala', q('gala'))).toBe(0);
    expect(matchTier('Gala de printemps', q('gala'))).toBe(1);
    expect(matchTier('Le gala de printemps', q('print gala'))).toBe(2);
    expect(matchTier('Bureau des élèves', q('eleve'))).toBe(2);
    expect(matchTier('Superbowl', q('bowl'))).toBe(3);
    expect(matchTier('Printemps', q('prnitemps'))).toBe(4);
  });

  it('folds case and accents on both sides', () => {
    expect(matchTier('Réunion', q('REUNION'))).toBe(0);
  });

  it('asks EVERY typed word to match: a conjunction', () => {
    expect(matchTier('Jean Martin', q('jean dupont'))).toBeNull();
  });

  it('gives a three-letter word no typo tolerance', () => {
    expect(matchTier('Bal', q('bla'))).toBeNull();
  });

  it('matches nothing on an empty query', () => {
    expect(matchTier('anything', q('   '))).toBeNull();
  });
});

describe('rankByLabels', () => {
  it('puts the best tier first and keeps the given order inside a tier', () => {
    const items = ['Atelier gala', 'Gala', 'Comité gala', 'Gala de fin'];
    expect(rankByLabels(items, 'gala', (s) => [s])).toEqual([
      'Gala',
      'Gala de fin',
      'Atelier gala',
      'Comité gala',
    ]);
  });

  it('takes the best of the labels of an item', () => {
    const items = [{ name: 'Bureau', alias: 'BDE' }];
    expect(rankByLabels(items, 'bde', (i) => [i.name, i.alias])).toHaveLength(1);
  });
});

describe('containsEveryToken', () => {
  it('finds every word anywhere in a body, folded', () => {
    expect(containsEveryToken('on se voit a la reunion demain', foldQuery('Réunion DEMAIN'))).toBe(
      true
    );
    expect(containsEveryToken('on se voit demain', foldQuery('reunion demain'))).toBe(false);
  });
});
