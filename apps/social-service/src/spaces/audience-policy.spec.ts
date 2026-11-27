import { HttpException } from '@nestjs/common';
import {
  AUDIENCE_ERROR,
  assertAudienceAllowedForType,
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
describe('what the type of an entity allows its audience to be (decisions 3 and 6)', () => {
  const codeOf = (type: string, rules: { formation: string | null; campus: string | null }[]) => {
    try {
      assertAudienceAllowedForType(type, rules);
      return null;
    } catch (e) {
      return ((e as HttpException).getResponse() as { code: string }).code;
    }
  };
  const se = { formation: null, campus: 'saint-etienne' };
  const seIcm = { formation: 'ICM', campus: 'saint-etienne' };
  const seIsmin = { formation: 'ISMIN', campus: 'saint-etienne' };
  const gaIcm = { formation: 'ICM', campus: 'gardanne' };

  it.each(['association', 'list', 'a type added later'])(
    'holds a %s to ONE campus, however many of its formations',
    (type) => {
      expect(codeOf(type, [])).toBeNull();
      expect(codeOf(type, [se])).toBeNull();
      expect(codeOf(type, [seIcm, seIsmin])).toBeNull();
      // Present on two campuses, it is two entities - whoever writes, the platform admin included.
      expect(codeOf(type, [seIcm, gaIcm])).toBe(AUDIENCE_ERROR.ONE_CAMPUS_ONLY);
      expect(codeOf(type, [se, gaIcm])).toBe(AUDIENCE_ERROR.ONE_CAMPUS_ONLY);
      // `everyone` is named as such, with or without a campus rule beside it.
      expect(codeOf(type, [{ formation: null, campus: null }])).toBe(
        AUDIENCE_ERROR.EVERYONE_INSTITUTION_ONLY
      );
      expect(codeOf(type, [se, { formation: 'ICM', campus: null }])).toBe(
        AUDIENCE_ERROR.EVERYONE_INSTITUTION_ONLY
      );
    }
  );

  it('refuses a stored two-campus audience written back UNCHANGED: the rule is about what an entity holds, not about what changed', () => {
    // No such entity exists (measured on production, 2026-11-15). Were one to appear - a row
    // written before the rule, a restore - its editor would be answered the typed refusal until
    // the audience is brought to one campus: it is never kept by resubmitting it.
    const stored = [seIcm, gaIcm];
    expect(codeOf('association', stored)).toBe(AUDIENCE_ERROR.ONE_CAMPUS_ONLY);
    expect(codeOf('association', [seIcm])).toBeNull();
  });

  it('lets an institution address two campuses, or everyone', () => {
    expect(codeOf('institution', [seIcm, gaIcm])).toBeNull();
    expect(codeOf('institution', [{ formation: null, campus: null }])).toBeNull();
  });
});

describe('ruleInsideGovernedSpaces', () => {
  const se = (formation: string, governed: boolean): SpaceStanding => ({
    formation,
    campus: 'saint-etienne',
    governed,
  });
  const twoBdes = [se('ICM', true), se('ISMIN', false), se('FISA', false)];

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
  const icmStar = [se('ICM', true), se('ISMIN', false), se('FISA', false)];
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
      codeOf(() =>
        assertBdeMayWriteAudience('association', icmStar, icmStar, governs, wide, submitted)
      );
    expect(write(true, [...wide, icm])).toBeNull();
    expect(write(true, [icm])).toBe('AUDIENCE_RULE_BEYOND_BDE_SPACES');
    expect(write(true, [])).toBe('AUDIENCE_RULE_BEYOND_BDE_SPACES');
    expect(write(true, [...wide, { formation: 'ICM', campus: 'gardanne' }])).toBe(
      'AUDIENCE_RULE_BEYOND_BDE_SPACES'
    );
    // Not governing the entity: nothing, its own space included - no takeover by addition.
    expect(write(false, [...wide, icm])).toBe('AUDIENCE_OUTSIDE_BDE_CAMPUS');
  });

  it("writes inside its PARENT's spaces only, never another BDE the same person manages (WP-D2)", () => {
    // The star holds MANAGE_ASSO in two BDEs: ICM's (the entity's parent) and FISA's. It READS
    // across both, and WRITES inside the parent's spaces alone (G8, D1).
    const reader = [se('ICM', true), se('ISMIN', false), se('FISA', true)];
    const parent = [se('ICM', true), se('ISMIN', false), se('FISA', false)];
    const fisa = { formation: 'FISA', campus: 'saint-etienne' };
    const write = (submitted: (typeof icm)[]) =>
      codeOf(() => assertBdeMayWriteAudience('list', reader, parent, true, [icm], submitted));
    expect(write([icm])).toBeNull();
    expect(write([icm, fisa])).toBe('AUDIENCE_RULE_BEYOND_BDE_SPACES');
  });

  it('lets a parent read its child wherever its rules lie, and no one else beyond its campus', () => {
    const gardanne = [{ formation: null, campus: 'gardanne' }];
    expect(codeOf(() => assertBdeMayReadAudience('association', icmStar, gardanne, true))).toBe(
      null
    );
    expect(codeOf(() => assertBdeMayReadAudience('association', icmStar, gardanne, false))).toBe(
      'AUDIENCE_OUTSIDE_BDE_CAMPUS'
    );
    // Even "governing" an institution reads nothing: it is the platform admin's (G9).
    expect(codeOf(() => assertBdeMayReadAudience('institution', icmStar, gardanne, true))).toBe(
      'AUDIENCE_INSTITUTION_ADMIN_ONLY'
    );
  });
});
