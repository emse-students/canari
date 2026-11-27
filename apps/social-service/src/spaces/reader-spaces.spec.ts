import { REVIEW_COHORT_ENV } from '../review-cohort';
import {
  campusWideReaderCampus,
  isStaffProfile,
  readerSpaces,
  type SpacePair,
} from './reader-spaces';

/** Every pair the migration seeds (D4 x D6). */
const SPACES: SpacePair[] = (['ICM', 'ISMIN', 'FISA', 'PDIS', 'Autre'] as const).flatMap(
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

describe('isStaffProfile (owner, 2026-11-24: staff is a post EMSE or ME, and nothing else)', () => {
  const saved = process.env[REVIEW_COHORT_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[REVIEW_COHORT_ENV];
    else process.env[REVIEW_COHORT_ENV] = saved;
  });

  it.each([
    ['a post EMSE, no cursus', { campus: 'gardanne', cursus: [], posts: ['EMSE'] }, true],
    ['a post ME, no cursus', { campus: 'gardanne', cursus: [], posts: ['ME'] }, true],
    [
      'a cursus AND a post EMSE (student and staff at once)',
      { campus: 'gardanne', cursus: [{ formation: 'ICM', promo: 2021 }], posts: ['EMSE'] },
      true,
    ],
    [
      'a cursus AND a post ME',
      { campus: 'gardanne', cursus: [{ formation: 'ICM', promo: 2021 }], posts: ['ALUMNI', 'ME'] },
      true,
    ],
    ['ALUMNI only, no cursus', { campus: 'gardanne', cursus: [], posts: ['ALUMNI'] }, false],
    ['no cursus and no post', { campus: 'gardanne', cursus: [], posts: [] }, false],
    ['posts that are not an array', { campus: 'gardanne', cursus: [], posts: 'EMSE' }, false],
  ])('%s -> %s', (_label, user, expected) => {
    expect(isStaffProfile(user)).toBe(expected);
  });

  it('never counts a review account, whatever its posts', () => {
    process.env[REVIEW_COHORT_ENV] = 'reviewer';
    expect(
      isStaffProfile({ id: 'reviewer', campus: 'gardanne', cursus: [], posts: ['EMSE'] })
    ).toBe(false);
    expect(isStaffProfile({ id: 'other', campus: 'gardanne', cursus: [], posts: ['EMSE'] })).toBe(
      true
    );
  });
});

describe('campusWideReaderCampus', () => {
  it('is the campus of a STAFF reader (a post EMSE or ME)', () => {
    expect(campusWideReaderCampus({ campus: 'saint-etienne', cursus: [], posts: ['EMSE'] })).toBe(
      'saint-etienne'
    );
    expect(campusWideReaderCampus({ campus: 'gardanne', cursus: null, posts: ['ME'] })).toBe(
      'gardanne'
    );
  });
  it('is null without a staff post, without a campus, and for a review account', () => {
    expect(campusWideReaderCampus({ campus: 'gardanne', cursus: [], posts: [] })).toBeNull();
    expect(
      campusWideReaderCampus({ campus: 'gardanne', cursus: [], posts: ['ALUMNI'] })
    ).toBeNull();
    expect(campusWideReaderCampus({ campus: null, cursus: [], posts: ['EMSE'] })).toBeNull();
    const saved = process.env[REVIEW_COHORT_ENV];
    process.env[REVIEW_COHORT_ENV] = 'reviewer';
    try {
      expect(
        campusWideReaderCampus({ id: 'reviewer', campus: 'gardanne', cursus: [], posts: ['EMSE'] })
      ).toBeNull();
    } finally {
      if (saved === undefined) delete process.env[REVIEW_COHORT_ENV];
      else process.env[REVIEW_COHORT_ENV] = saved;
    }
  });
});
