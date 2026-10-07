import { describe, expect, it } from 'vitest';
import {
  ALL_CELLS,
  campusCells,
  cellOf,
  coverage,
  reachChoiceToRules,
  reachedCells,
  toggleGroup,
  toRules,
} from './audienceRules';

describe('audience rules as pairs', () => {
  it('reads null as any', () => {
    expect(reachedCells([{ formation: null, campus: null }]).size).toBe(ALL_CELLS.length);
    expect(reachedCells([{ formation: null, campus: 'gardanne' }])).toEqual(
      new Set(campusCells('gardanne'))
    );
    expect(reachedCells([{ formation: 'ICM', campus: 'saint-etienne' }])).toEqual(
      new Set([cellOf('ICM', 'saint-etienne')])
    );
  });

  it('writes the smallest equivalent rule set', () => {
    expect(toRules(new Set(ALL_CELLS))).toEqual([{ formation: null, campus: null }]);
    expect(toRules(new Set(campusCells('saint-etienne')))).toEqual([
      { formation: null, campus: 'saint-etienne' },
    ]);
    expect(toRules(new Set([cellOf('ICM', 'gardanne'), cellOf('FSSS', 'gardanne')]))).toEqual([
      { formation: 'ICM', campus: 'gardanne' },
      { formation: 'FSSS', campus: 'gardanne' },
    ]);
    expect(toRules(new Set())).toEqual([]);
  });

  it('round-trips: a stored rule set is read back as the same pairs', () => {
    const rules = [
      { formation: null, campus: 'saint-etienne' as const },
      { formation: 'ISMIN' as const, campus: 'gardanne' as const },
    ];
    expect(reachedCells(toRules(reachedCells(rules)))).toEqual(reachedCells(rules));
  });

  it('turning one formation off inside a whole campus leaves the others', () => {
    const reached = reachedCells([{ formation: null, campus: 'saint-etienne' }]);
    reached.delete(cellOf('FSSS', 'saint-etienne'));
    expect(toRules(reached)).toEqual([
      { formation: 'ICM', campus: 'saint-etienne' },
      { formation: 'ISMIN', campus: 'saint-etienne' },
      { formation: 'PDIS', campus: 'saint-etienne' },
      { formation: 'Autre', campus: 'saint-etienne' },
    ]);
  });

  it('toggles a group like a parent checkbox, and reports partial coverage', () => {
    const none = new Set<ReturnType<typeof cellOf>>();
    const campus = campusCells('gardanne');
    const all = toggleGroup(none, campus);
    expect(coverage(campus, all)).toBe('all');
    expect(toggleGroup(all, campus).size).toBe(0);
    const some = new Set([cellOf('ICM', 'gardanne')]);
    expect(coverage(campus, some)).toBe('some');
    expect(coverage(campus, toggleGroup(some, campus))).toBe('all');
  });
});

describe('reachChoiceToRules', () => {
  it('maps each choice to its rule set', () => {
    expect(reachChoiceToRules('none', '', '')).toEqual([]);
    expect(reachChoiceToRules('school', '', '')).toEqual([{ formation: null, campus: null }]);
    expect(reachChoiceToRules('campus', 'saint-etienne', '')).toEqual([
      { formation: null, campus: 'saint-etienne' },
    ]);
    expect(reachChoiceToRules('cell', 'gardanne', 'ICM')).toEqual([
      { formation: 'ICM', campus: 'gardanne' },
    ]);
  });

  it('never widens a half-filled choice', () => {
    expect(reachChoiceToRules('campus', '', '')).toEqual([]);
    expect(reachChoiceToRules('cell', 'gardanne', '')).toEqual([]);
    expect(reachChoiceToRules('cell', '', 'ICM')).toEqual([]);
  });
});
