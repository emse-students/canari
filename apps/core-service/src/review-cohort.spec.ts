import {
  REVIEW_COHORT_ENV,
  ReviewCohortConfigError,
  inReviewCohortSql,
  isInReviewCohort,
  parseReviewCohort,
  reviewCohort,
} from './review-cohort';

/**
 * The review cohort's parsing and its SQL. The module is BYTE-IDENTICAL in social-service
 * (declared-duplicates.mjs), so this one spec proves both copies.
 */
describe('review cohort', () => {
  const A = 'aa01';
  const B = 'bb02';
  const saved = process.env[REVIEW_COHORT_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[REVIEW_COHORT_ENV];
    else process.env[REVIEW_COHORT_ENV] = saved;
  });

  it('reads an absent or blank value as no cohort', () => {
    expect(parseReviewCohort(undefined)).toEqual([]);
    expect(parseReviewCohort('  ')).toEqual([]);
  });

  it('reads the one-id value it held before the cohort as a one-member cohort', () => {
    expect(parseReviewCohort(` ${A} `)).toEqual([A]);
  });

  it('reads a list, ignoring blank entries and repeats', () => {
    expect(parseReviewCohort(`${A}, ${B},,${A}`)).toEqual([A, B]);
  });

  it.each([['AA01'], ["aa01'--"], ['not-an-id'], [`${A} ${B}`]])(
    'refuses %j, naming the position and never the text',
    (bad) => {
      const run = () => parseReviewCohort(`${A},${bad}`);
      expect(run).toThrow(ReviewCohortConfigError);
      expect(run).toThrow(`${REVIEW_COHORT_ENV} entry 2 is not a lower-case hex user id`);
    }
  );

  it('reads the environment on every call', () => {
    process.env[REVIEW_COHORT_ENV] = A;
    expect(reviewCohort()).toEqual([A]);
    process.env[REVIEW_COHORT_ENV] = `${A},${B}`;
    expect(reviewCohort()).toEqual([A, B]);
    expect(isInReviewCohort(B)).toBe(true);
    expect(isInReviewCohort('cc03')).toBe(false);
    expect(isInReviewCohort(undefined)).toBe(false);
  });

  it('writes the constant false with no cohort, so a spliced query is unchanged', () => {
    delete process.env[REVIEW_COHORT_ENV];
    expect(inReviewCohortSql('u.id')).toBe('false');
  });

  it('writes an IN list of the inlined ids', () => {
    process.env[REVIEW_COHORT_ENV] = `${A},${B}`;
    expect(inReviewCohortSql('u.id')).toBe(`(u.id IN ('${A}', '${B}'))`);
  });
});
