import { readerSpaces, rulesOutsideCeiling, type SpacePair } from './reader-spaces';

/** Every pair the migration seeds (D4 x D6). */
const SPACES: SpacePair[] = (['ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre'] as const).flatMap(
  (formation) => (['saint-etienne', 'gardanne'] as const).map((campus) => ({ formation, campus }))
);

describe('readerSpaces', () => {
  it('is each cursus formation on the reader campus', () => {
    expect(
      readerSpaces(
        {
          campus: 'saint-etienne',
          cursus: [
            { formation: 'ICM', promo: 2022 },
            { formation: 'Autre', promo: 2025 },
          ],
        },
        SPACES
      )
    ).toEqual([
      { formation: 'ICM', campus: 'saint-etienne' },
      { formation: 'Autre', campus: 'saint-etienne' },
    ]);
  });

  it('never crosses to the other campus, whatever the formation', () => {
    expect(
      readerSpaces({ campus: 'gardanne', cursus: [{ formation: 'ICM', promo: 2022 }] }, SPACES)
    ).toEqual([{ formation: 'ICM', campus: 'gardanne' }]);
  });

  it.each([
    ['no campus', { campus: null, cursus: [{ formation: 'ICM', promo: 2022 }] }],
    ['no cursus (staff with a post only)', { campus: 'saint-etienne', cursus: [] }],
    ['a cursus that is not an array', { campus: 'saint-etienne', cursus: { formation: 'ICM' } }],
    ['a formation no space carries', { campus: 'saint-etienne', cursus: [{ formation: 'CMP' }] }],
  ])('is empty with %s', (_label, user) => {
    expect(readerSpaces(user, SPACES)).toEqual([]);
  });
});

describe('rulesOutsideCeiling', () => {
  const icmSe = { formation: 'ICM', campus: 'saint-etienne' } as const;
  const wholeSe = { formation: null, campus: 'saint-etienne' } as const;
  const everyone = { formation: null, campus: null } as const;

  it('accepts a narrowing: one pair inside a campus-wide ceiling', () => {
    expect(rulesOutsideCeiling([icmSe], [wholeSe], SPACES)).toEqual([]);
  });

  it('refuses a widening: a whole campus under a one-pair ceiling', () => {
    expect(rulesOutsideCeiling([wholeSe], [icmSe], SPACES)).toEqual([wholeSe]);
  });

  it('accepts a rule covered only by the UNION of several ceiling rules', () => {
    const fivePairs = (['ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre'] as const).map((formation) => ({
      formation,
      campus: 'saint-etienne' as const,
    }));
    expect(rulesOutsideCeiling([wholeSe], fivePairs, SPACES)).toEqual([]);
  });

  it('refuses everything under an empty ceiling (an association that reaches nobody)', () => {
    expect(rulesOutsideCeiling([icmSe], [], SPACES)).toEqual([icmSe]);
  });

  it('accepts anything under an everyone ceiling', () => {
    expect(rulesOutsideCeiling([everyone, icmSe], [everyone], SPACES)).toEqual([]);
  });
});
