import { ruleInsideGovernedSpaces, type SpaceStanding } from './audience-policy';

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
