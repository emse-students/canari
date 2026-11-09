import { describe, expect, it } from 'vitest';
import { classifyMapAssociations, parkedPlacements } from './mapEntries';
import type { PosterEntry } from '$lib/associations/api';

const entry = (associationId: string, enabled: boolean, zoneId: string | null = null) =>
  ({ posterProjectId: 'p', associationId, enabled, zoneId }) as PosterEntry;

describe('classifyMapAssociations', () => {
  it('splits the space into on, off and new, by the entries alone', () => {
    const { on, off, fresh, zoneOf } = classifyMapAssociations(
      ['a', 'b', 'c'],
      [entry('a', true, 'z1'), entry('b', false), entry('gone', true)]
    );
    expect([...on]).toEqual(['a']);
    expect([...off]).toEqual(['b']);
    expect([...fresh]).toEqual(['c']);
    // An entry for an association no longer of the space is not offered, even switched on.
    expect(on.has('gone')).toBe(false);
    expect(zoneOf).toEqual({ a: 'z1', b: null, c: null });
  });
});

describe('parkedPlacements', () => {
  it('keeps the saved placement of every association the model does not draw', () => {
    const saved = [
      { assoId: 'a', x: 1 },
      { assoId: 'b', x: 2 },
    ];
    expect(parkedPlacements(saved, new Set(['a']))).toEqual([{ assoId: 'b', x: 2 }]);
  });
});
