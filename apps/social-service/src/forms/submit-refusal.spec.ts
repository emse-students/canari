import { factsOf } from '../pricing/facts.it-fixture';
import { FORM_COTISATION_HELD, FORM_NOT_OPEN_TO_YOU, submitRefusalCode } from './submit-refusal';

describe('submitRefusalCode', () => {
  const facts = factsOf;

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

  // D32: a submission allowed for any of a person's cursus is allowed.
  it('admits through the SECOND cursus, and names a held cotisation first whatever the cursus', () => {
    const twoCursus = facts({
      cursus: [
        { formation: 'ISMIN', promo: 2023 },
        { formation: 'ICM', promo: 2024 },
      ],
    });
    expect(submitRefusalCode({ promo: { values: [2024] } }, twoCursus)).toBeNull();
    expect(
      submitRefusalCode(
        { promo: { values: [2020] }, notCotisation: { anyTier: true } },
        { ...twoCursus, cotisationTiers: ['bde'] }
      )
    ).toBe(FORM_COTISATION_HELD);
  });
});
