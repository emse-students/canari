import { describe, expect, it } from 'vitest';

import { familyNameKey, sortByFamilyName, type PersonNameParts } from './familyNameOrder';

type Row = PersonNameParts & { id: string };

const order = (rows: Row[]) =>
  sortByFamilyName(
    rows,
    (row) => row,
    (row) => row.id
  ).map((row) => row.id);

describe('sortByFamilyName', () => {
  it('orders by family name, not by the given name that leads the printed one', () => {
    expect(
      order([
        { id: 'hugo', firstName: 'Hugo', lastName: 'VIENNE' },
        { id: 'maxime', firstName: 'Maxime', lastName: 'BASEL' },
        { id: 'gabriel', firstName: 'Gabriel', lastName: 'DUPONT' },
        { id: 'melvin', firstName: 'Melvin', lastName: 'BRETON--DESCHAMPS' },
      ])
    ).toEqual(['maxime', 'melvin', 'gabriel', 'hugo']);
  });

  it('lets neither accents nor case reorder a list', () => {
    // "É" is E with an acute accent: under a code-unit sort it lands after every ASCII letter.
    expect(
      order([
        { id: 'z', firstName: 'Zoe', lastName: 'zola' },
        { id: 'e', firstName: 'Emile', lastName: 'ÉTIENNE' },
        { id: 'a', firstName: 'Anne', lastName: 'Abel' },
      ])
    ).toEqual(['a', 'e', 'z']);
  });

  it('keeps a hyphenated surname right after the single one it starts with, deterministically', () => {
    const rows: Row[] = [
      { id: 'compound', firstName: 'Melvin', lastName: 'BRETON--DESCHAMPS' },
      { id: 'single', firstName: 'Zoe', lastName: 'Breton' },
      { id: 'particle', firstName: 'Jean', lastName: 'de La Fontaine' },
    ];
    expect(order(rows)).toEqual(['single', 'compound', 'particle']);
    expect(order([...rows].reverse())).toEqual(['single', 'compound', 'particle']);
  });

  it('breaks an equal family name on the given name, then on the id', () => {
    expect(
      order([
        { id: 'u2', firstName: 'Yves', lastName: 'Martin' },
        { id: 'u3', firstName: 'alice', lastName: 'MARTIN' },
        { id: 'u1', firstName: 'Alice', lastName: 'Martin' },
      ])
    ).toEqual(['u1', 'u3', 'u2']);
  });

  it('sorts a person with no family name under the name printed for them', () => {
    expect(
      order([
        { id: 'martin', firstName: 'Alice', lastName: 'Martin' },
        { id: 'casimir', displayName: 'Casimir' },
        { id: 'bernard', firstName: 'Zoe', lastName: 'Bernard' },
      ])
    ).toEqual(['bernard', 'casimir', 'martin']);
  });

  it('puts unnamed people last, in id order, whatever order they arrived in', () => {
    const rows = [
      { id: 'c', firstName: ' ', lastName: '' },
      { id: 'b', firstName: 'Zoe', lastName: 'Zola' },
      { id: 'a' },
    ];
    expect(order(rows)).toEqual(['b', 'a', 'c']);
    expect(
      sortByFamilyName(
        ['y', 'x', 'w'],
        (id) => (id === 'w' ? { lastName: 'Abel' } : null),
        (id) => id
      )
    ).toEqual(['w', 'x', 'y']);
  });

  it('does not mutate its input', () => {
    const rows: Row[] = [
      { id: 'b', lastName: 'B' },
      { id: 'a', lastName: 'A' },
    ];
    order(rows);
    expect(rows.map((row) => row.id)).toEqual(['b', 'a']);
  });
});

describe('familyNameKey', () => {
  it('answers null for a person nothing names', () => {
    expect(familyNameKey(null)).toBeNull();
    expect(familyNameKey({ firstName: '  ', lastName: null, displayName: '' })).toBeNull();
  });

  it('falls back to the given name alone for a mononym', () => {
    expect(familyNameKey({ firstName: 'Casimir' })).toEqual({
      family: 'Casimir',
      given: 'Casimir',
    });
  });
});
