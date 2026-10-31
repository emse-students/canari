import {
  REVIEW_COHORT_BOUNDARY,
  REVIEW_COHORT_ENV,
  ReviewCohortBoundaryException,
  ReviewCohortConfigError,
  assertReviewCohortConfigured,
  assertSameSideOfReviewCohort,
  inReviewCohortSql,
  isInReviewCohort,
  parseReviewCohort,
  reviewCohort,
  sameSideOfReviewCohort,
} from './review-cohort';

/**
 * The review cohort's parsing, its boundary and its SQL. The module is BYTE-IDENTICAL in
 * social-service and chat-delivery-service (declared-duplicates.mjs), so this one spec proves all
 * three copies.
 */
describe('review cohort', () => {
  const A = 'aa01';
  const B = 'Bb-02';
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

  it('reads a list lower-cased, ignoring blank entries and repeats - a repeat in another case too', () => {
    expect(parseReviewCohort(`${A}, ${B},,${A},BB-02`)).toEqual([A, 'bb-02']);
  });

  it("accepts every id the mint rule accepts, quotes included (user-id.ts), but ',' and ':'", () => {
    expect(parseReviewCohort(`it's,"x"`)).toEqual([`it's`, '"x"']);
  });

  it.each([['dev:1'], ['é'], [`${A} ${B}`]])(
    'refuses %j, naming the position and never the text',
    (bad) => {
      const run = () => parseReviewCohort(`${A},${bad}`);
      expect(run).toThrow(ReviewCohortConfigError);
      expect(run).toThrow(`${REVIEW_COHORT_ENV} entry 2 is not a user id`);
    }
  );

  it('throws at boot on a bad entry, and counts a good cohort', () => {
    process.env[REVIEW_COHORT_ENV] = `${A},dev:1`;
    expect(() => assertReviewCohortConfigured()).toThrow(ReviewCohortConfigError);
    process.env[REVIEW_COHORT_ENV] = `${A},${B}`;
    expect(assertReviewCohortConfigured()).toBe(2);
  });

  it('reads the environment on every call', () => {
    process.env[REVIEW_COHORT_ENV] = A;
    expect(reviewCohort()).toEqual([A]);
    process.env[REVIEW_COHORT_ENV] = `${A},${B}`;
    expect(reviewCohort()).toEqual([A, 'bb-02']);
    // Compared lower-cased on both sides, as every service compares a user id.
    expect(isInReviewCohort(B)).toBe(true);
    expect(isInReviewCohort('bb-02')).toBe(true);
    expect(isInReviewCohort('BB-02')).toBe(true);
    expect(isInReviewCohort(undefined)).toBe(false);
  });

  it('puts two review accounts, or two members, on one side - and refuses across', () => {
    process.env[REVIEW_COHORT_ENV] = `${A},${B}`;
    expect(sameSideOfReviewCohort(A, B)).toBe(true);
    expect(sameSideOfReviewCohort('m1', 'm2')).toBe(true);
    expect(sameSideOfReviewCohort(A, 'm1')).toBe(false);
    expect(() => assertSameSideOfReviewCohort('m1', A)).toThrow(ReviewCohortBoundaryException);
    let refusal: unknown;
    try {
      assertSameSideOfReviewCohort(A, 'm1');
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(ReviewCohortBoundaryException);
    expect((refusal as ReviewCohortBoundaryException).getStatus()).toBe(403);
    expect((refusal as ReviewCohortBoundaryException).getResponse()).toEqual(
      expect.objectContaining({ code: REVIEW_COHORT_BOUNDARY })
    );
    delete process.env[REVIEW_COHORT_ENV];
    expect(sameSideOfReviewCohort(A, 'm1')).toBe(true);
  });

  it('writes the constant false with no cohort, so a spliced query is unchanged', () => {
    delete process.env[REVIEW_COHORT_ENV];
    expect(inReviewCohortSql('u.id')).toBe('false');
  });

  it('writes the list hex-encoded, so no quote in an id can reach the SQL text', () => {
    process.env[REVIEW_COHORT_ENV] = `${A},it's`;
    const sql = inReviewCohortSql('u.id');
    const hex = Buffer.from(`${A},it's`, 'utf8').toString('hex');
    expect(sql).toBe(
      `(u.id = ANY (string_to_array(convert_from(decode('${hex}', 'hex'), 'UTF8'), ',')))`
    );
    expect(sql).not.toContain("it's");
  });
});
