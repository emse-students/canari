/**
 * TWO PEOPLE OF THE SAME NAME ARE TOLD APART (D56): no detail without a homonym, the promo when the
 * promos differ, the formation when they are equal, and a warning - never a bare pair - when both
 * are equal. Names are compared folded, as the server's `normalizeName` folds them.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { distinguishHomonyms } from './distinguishHomonyms';

afterEach(() => vi.restoreAllMocks());

const row = (id: string, displayName: string, promo: number | null, formation: string | null) => ({
  id,
  displayName,
  promo,
  formation,
});

describe('distinguishHomonyms', () => {
  it('adds nothing to a name nobody else shown shares', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      distinguishHomonyms([
        row('a', 'Camille Durand', 2020, 'ICM'),
        row('b', 'Léa Martin', 2020, 'ICM'),
      ])
    ).toEqual(new Map());
    expect(warn).not.toHaveBeenCalled();
  });

  it('adds the promo when the promos differ', () => {
    const details = distinguishHomonyms([
      row('a', 'Camille Durand', 2018, 'ICM'),
      row('b', 'Camille Durand', 2021, 'ICM'),
    ]);
    expect(details.get('a')).toBe(m.picker_homonym_detail({ promo: 2018 }));
    expect(details.get('b')).toBe(m.picker_homonym_detail({ promo: 2021 }));
  });

  it('adds the formation when the promos are equal', () => {
    const details = distinguishHomonyms([
      row('a', 'Camille Durand', 2020, 'ICM'),
      row('b', 'Camille Durand', 2020, 'ISMIN'),
    ]);
    expect(details.get('a')).toBe('ICM');
    expect(details.get('b')).toBe('ISMIN');
  });

  it('warns, and still shows what it has, when promo and formation are equal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const details = distinguishHomonyms([
      row('a', 'Camille Durand', 2020, 'ICM'),
      row('b', 'Camille Durand', 2020, 'ICM'),
    ]);
    expect(details.get('a')).toBe(m.picker_homonym_detail({ promo: 2020 }));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[PICKER] homonyms with nothing to tell apart')
    );
    // No name in the line: it reaches the in-app log.
    expect(String(warn.mock.calls[0][0])).not.toContain('Camille');
  });

  it('folds accents, case, hyphens and apostrophes', () => {
    const details = distinguishHomonyms([
      row('a', 'Jean-Marie DUPONT', 2018, null),
      row('b', 'jean marie Dupont', 2021, null),
      row('c', 'Hélène d’Arc', 2019, null),
      row('d', "Helene d'Arc", 2022, null),
    ]);
    expect([...details.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('tells three homonyms apart by promo where it can, by formation where it must', () => {
    const details = distinguishHomonyms([
      row('a', 'Camille Durand', 2020, 'ICM'),
      row('b', 'Camille Durand', 2020, 'ISMIN'),
      row('c', 'Camille Durand', 2021, 'ICM'),
    ]);
    expect(details.get('a')).toBe('ICM');
    expect(details.get('b')).toBe('ISMIN');
    expect(details.get('c')).toBe(m.picker_homonym_detail({ promo: 2021 }));
  });
});
