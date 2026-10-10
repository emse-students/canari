import { describe, expect, it } from 'vitest';
import { offeredPresets, presetToRules, readPreset } from './audiencePresets';

describe('offeredPresets', () => {
  it('offers everyone to an institution only (decision 6)', () => {
    expect(offeredPresets('institution')).toEqual(['campus', 'formations', 'everyone']);
    expect(offeredPresets('association')).toEqual(['campus', 'formations']);
    expect(offeredPresets('list')).toEqual(['campus', 'formations']);
  });

  it('adds the custom grid for a reader who may use it, never otherwise', () => {
    expect(offeredPresets('association', true)).toEqual(['campus', 'formations', 'custom']);
    expect(offeredPresets('institution', true)).toEqual([
      'campus',
      'formations',
      'everyone',
      'custom',
    ]);
    expect(offeredPresets('institution', false)).not.toContain('custom');
  });
});

describe('presetToRules', () => {
  it('maps the three presets to the rules the server stores', () => {
    expect(presetToRules('campus', 'gardanne', [])).toEqual([
      { formation: null, campus: 'gardanne' },
    ]);
    expect(presetToRules('formations', 'gardanne', ['ICM', 'FSSS'])).toEqual([
      { formation: 'ICM', campus: 'gardanne' },
      { formation: 'FSSS', campus: 'gardanne' },
    ]);
    expect(presetToRules('everyone', '', [])).toEqual([{ formation: null, campus: null }]);
  });

  it('builds no rule for custom: its pairs come from the grid, not from a campus', () => {
    expect(presetToRules('custom', 'gardanne', ['ICM'])).toEqual([]);
  });

  it('never widens a half-filled choice: no campus or no formation yields no rule', () => {
    expect(presetToRules('campus', '', [])).toEqual([]);
    expect(presetToRules('formations', 'gardanne', [])).toEqual([]);
    expect(presetToRules('formations', '', ['ICM'])).toEqual([]);
  });

  it('never emits a campus-less formation rule, which is the multi-campus audience the server refuses', () => {
    for (const preset of ['campus', 'formations'] as const) {
      const rules = presetToRules(preset, 'saint-etienne', ['ICM']);
      expect(rules.every((r) => r.campus === 'saint-etienne')).toBe(true);
    }
  });
});

describe('readPreset', () => {
  it('reads back what presetToRules wrote', () => {
    expect(readPreset(presetToRules('campus', 'gardanne', []))).toEqual({
      preset: 'campus',
      campus: 'gardanne',
      formations: [],
    });
    expect(readPreset(presetToRules('formations', 'gardanne', ['ICM', 'PDIS']))).toEqual({
      preset: 'formations',
      campus: 'gardanne',
      formations: ['ICM', 'PDIS'],
    });
    expect(readPreset(presetToRules('everyone', '', []))?.preset).toBe('everyone');
  });

  it('calls anything else custom, never one of the three', () => {
    expect(readPreset([])).toBeNull();
    expect(
      readPreset([
        { formation: null, campus: 'gardanne' },
        { formation: null, campus: 'saint-etienne' },
      ])
    ).toBeNull();
    expect(
      readPreset([
        { formation: null, campus: 'gardanne' },
        { formation: 'ICM', campus: 'gardanne' },
      ])
    ).toBeNull();
    expect(readPreset([{ formation: 'ICM', campus: null }])).toBeNull();
  });
});
