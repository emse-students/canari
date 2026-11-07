import { HttpException } from '@nestjs/common';
import {
  assertBdeMayReadAudience,
  assertBdeMayWriteAudience,
  changedRules,
  ruleInsideGovernedSpaces,
  type SpaceStanding,
} from './audience-policy';

/**
 * The BDE star's audience bound is PER SPACE (2026-11-02): one campus can hold two BDEs, and a
 * per-campus bound let one rewrite the other's associations. The real SQL feeding it is proven in
 * `audience-takeover.integration.spec.ts`.
 */
describe('ruleInsideGovernedSpaces', () => {
  const se = (formation: string, governed: boolean): SpaceStanding => ({
    formation,
    campus: 'saint-etienne',
    governed,
  });
  const twoBdes = [se('ICM', true), se('ISMIN', false), se('FSSS', false)];

  it('keeps a formation rule inside only on a governed space', () => {
    expect(ruleInsideGovernedSpaces({ formation: 'ICM', campus: 'saint-etienne' }, twoBdes)).toBe(
      true
    );
    expect(ruleInsideGovernedSpaces({ formation: 'ISMIN', campus: 'saint-etienne' }, twoBdes)).toBe(
      false
    );
  });

  it('keeps a whole-campus rule inside only when every space of the campus is governed', () => {
    expect(ruleInsideGovernedSpaces({ formation: null, campus: 'saint-etienne' }, twoBdes)).toBe(
      false
    );
    const all = [se('ICM', true), se('ISMIN', true)];
    expect(ruleInsideGovernedSpaces({ formation: null, campus: 'saint-etienne' }, all)).toBe(true);
  });

  it('never keeps an everyone rule or a campus with no space', () => {
    expect(ruleInsideGovernedSpaces({ formation: null, campus: null }, twoBdes)).toBe(false);
    expect(ruleInsideGovernedSpaces({ formation: null, campus: 'gardanne' }, twoBdes)).toBe(false);
  });
});

/** The typed code a policy throws, or null when it passes. */
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    return (e.getResponse() as { code: string }).code;
  }
};

describe('"Lire tout, modifier dans ses espaces" (owner, 2026-11-03)', () => {
  const se = (formation: string, governed: boolean): SpaceStanding => ({
    formation,
    campus: 'saint-etienne',
    governed,
  });
  const icmStar = [se('ICM', true), se('ISMIN', false), se('FSSS', false)];
  const wide = [{ formation: null, campus: 'saint-etienne' }];
  const icm = { formation: 'ICM', campus: 'saint-etienne' };

  it('counts only the rules a write adds or removes', () => {
    expect(changedRules(wide, [...wide, icm])).toEqual([icm]);
    expect(changedRules([...wide, icm], wide)).toEqual([icm]);
    expect(changedRules(wide, wide)).toEqual([]);
  });

  it('reads an entity of its campus, whatever its rules exceed', () => {
    expect(codeOf(() => assertBdeMayReadAudience('association', icmStar, wide))).toBeNull();
    expect(codeOf(() => assertBdeMayReadAudience('association', icmStar, []))).toBeNull();
    expect(
      codeOf(() =>
        assertBdeMayReadAudience('association', icmStar, [{ formation: null, campus: 'gardanne' }])
      )
    ).toBe('AUDIENCE_OUTSIDE_BDE_CAMPUS');
    expect(codeOf(() => assertBdeMayReadAudience('institution', icmStar, wide))).toBe(
      'AUDIENCE_INSTITUTION_ADMIN_ONLY'
    );
  });

  it('adds inside its spaces, leaves the wider rule, and may not touch it', () => {
    const write = (governs: boolean, submitted: typeof wide) =>
      codeOf(() => assertBdeMayWriteAudience('association', icmStar, governs, wide, submitted));
    expect(write(true, [...wide, icm])).toBeNull();
    expect(write(true, [icm])).toBe('AUDIENCE_RULE_BEYOND_BDE_SPACES');
    expect(write(true, [])).toBe('AUDIENCE_RULE_BEYOND_BDE_SPACES');
    expect(write(true, [...wide, { formation: 'ICM', campus: 'gardanne' }])).toBe(
      'AUDIENCE_RULE_BEYOND_BDE_SPACES'
    );
    // Not governing the entity: nothing, its own space included - no takeover by addition.
    expect(write(false, [...wide, icm])).toBe('AUDIENCE_OUTSIDE_BDE_CAMPUS');
  });
});
