import { campusWideReaderCampus, readerSpaces, type SpacePair } from './reader-spaces';

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

describe('campusWideReaderCampus', () => {
  it('is the campus of a reader with a campus and an empty cursus (EMSE staff)', () => {
    expect(campusWideReaderCampus({ campus: 'saint-etienne', cursus: [] })).toBe('saint-etienne');
    expect(campusWideReaderCampus({ campus: 'gardanne', cursus: null })).toBe('gardanne');
  });
  it('is null for a student, for no campus, and for a malformed cursus', () => {
    expect(
      campusWideReaderCampus({ campus: 'gardanne', cursus: [{ formation: 'ICM', promo: 2021 }] })
    ).toBeNull();
    expect(campusWideReaderCampus({ campus: null, cursus: [] })).toBeNull();
    expect(campusWideReaderCampus({ campus: 'gardanne', cursus: 'ICM' })).toBeNull();
  });
});
