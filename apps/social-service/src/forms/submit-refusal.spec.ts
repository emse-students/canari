import type { PricingFacts } from '../pricing/audience';
import { FORM_COTISATION_HELD, FORM_NOT_OPEN_TO_YOU, submitRefusalCode } from './submit-refusal';

describe('submitRefusalCode', () => {
  const facts = (over: Partial<PricingFacts> = {}): PricingFacts => ({
    promo: null,
    formation: null,
    cotisationTiers: [],
    answers: {},
    ...over,
  });

  // An absent condition is every form that existed before 2026-10-30: nothing changes for them.
  it('is null with no condition, or one the person meets', () => {
    expect(submitRefusalCode(null, facts())).toBeNull();
    expect(submitRefusalCode({ notCotisation: { anyTier: true } }, facts())).toBeNull();
  });

  it('types a held cotisation apart from every other refusal', () => {
    expect(
      submitRefusalCode({ notCotisation: { anyTier: true } }, facts({ cotisationTiers: [null] }))
    ).toBe(FORM_COTISATION_HELD);
    expect(submitRefusalCode({ cotisation: { anyTier: true } }, facts())).toBe(
      FORM_NOT_OPEN_TO_YOU
    );
    expect(submitRefusalCode({ promo: { values: [2024] } }, facts())).toBe(FORM_NOT_OPEN_TO_YOU);
  });
});
