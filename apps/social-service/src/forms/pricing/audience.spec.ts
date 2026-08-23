import {
  bucketFor,
  findOverlappingBuckets,
  matchesCondition,
  needsProfile,
  OTHERS_BUCKET_ID,
  type Dimension,
  type SubmitterFacts,
} from './audience';

/**
 * The one predicate behind a price, a question's visibility and who may submit.
 *
 * Every test here fixes `now`, so nothing depends on the day it runs - which matters most for
 * `yearsToGraduation`, whose answer changes every September.
 */
describe('audience predicate', () => {
  /** 23 August 2026: still academic year 2025-2026, so the year it ENDS in is 2026. */
  const BEFORE_ROLL = new Date('2026-08-23T12:00:00Z');
  /** 23 September 2026: academic year 2026-2027, ending 2027. */
  const AFTER_ROLL = new Date('2026-09-23T12:00:00Z');

  const facts = (over: Partial<SubmitterFacts> = {}): SubmitterFacts => ({
    promo: null,
    formation: null,
    cotisationTiers: [],
    answers: {},
    now: BEFORE_ROLL,
    ...over,
  });

  describe('cotisation', () => {
    const dimension: Dimension = {
      id: 'd1',
      kind: 'cotisation',
      buckets: [
        { id: 'alcool', label: 'Avec alcool', variantKeys: ['avec-alcool'] },
        { id: 'base', label: 'Cotisation simple', variantKeys: [null] },
      ],
    };

    it('places a cotisant in their own tier bucket', () => {
      expect(bucketFor(dimension, facts({ cotisationTiers: ['avec-alcool'] }))).toBe('alcool');
    });

    // `null` is the base tier, a value like any other - not a missing one.
    it('treats the base tier as a tier', () => {
      expect(bucketFor(dimension, facts({ cotisationTiers: [null] }))).toBe('base');
    });

    it('places a non-cotisant in "everyone else"', () => {
      expect(bucketFor(dimension, facts())).toBe(OTHERS_BUCKET_ID);
    });

    // The whole point of storing a REFERENCE: a tier created after the form was saved still counts
    // as a cotisation, where a stored list of tier keys would have dropped them into `others`.
    it('accepts a tier the form never named, when the group takes any tier', () => {
      const anyTier: Dimension = {
        id: 'd1',
        kind: 'cotisation',
        buckets: [{ id: 'cot', label: 'Cotisant', anyTier: true }],
      };
      expect(bucketFor(anyTier, facts({ cotisationTiers: ['invented-last-week'] }))).toBe('cot');
    });
  });

  describe('promo', () => {
    const graduation: Dimension = {
      id: 'd1',
      kind: 'promo',
      mode: 'graduationYear',
      buckets: [{ id: 'p2028', label: 'Promo 2028', values: [2028] }],
    };
    const relative: Dimension = {
      id: 'd1',
      kind: 'promo',
      mode: 'yearsToGraduation',
      buckets: [{ id: 'first', label: '1A', values: [2] }],
    };

    it('matches an absolute promo', () => {
      expect(bucketFor(graduation, facts({ promo: 2028 }))).toBe('p2028');
      expect(bucketFor(graduation, facts({ promo: 2029 }))).toBe(OTHERS_BUCKET_ID);
    });

    // The reason the relative mode exists: the same bucket picks the next cohort a year later,
    // where "promo 2028" would have gone stale. Two dates, one bucket, two different promos.
    it('rolls a relative bucket over in September', () => {
      expect(bucketFor(relative, facts({ promo: 2028, now: BEFORE_ROLL }))).toBe('first');
      expect(bucketFor(relative, facts({ promo: 2028, now: AFTER_ROLL }))).toBe(OTHERS_BUCKET_ID);
      expect(bucketFor(relative, facts({ promo: 2029, now: AFTER_ROLL }))).toBe('first');
    });

    // 5 users on prod have no promo. Treating a missing value as a year would price somebody on the
    // strength of a blank field.
    it('places a submitter with no promo in "everyone else", in both modes', () => {
      expect(bucketFor(graduation, facts({ promo: null }))).toBe(OTHERS_BUCKET_ID);
      expect(bucketFor(relative, facts({ promo: null }))).toBe(OTHERS_BUCKET_ID);
    });
  });

  describe('formation', () => {
    const dimension: Dimension = {
      id: 'd1',
      kind: 'formation',
      buckets: [{ id: 'icm', label: 'ICM', values: ['ICM'] }],
    };

    it('matches a listed formation', () => {
      expect(bucketFor(dimension, facts({ formation: 'ICM' }))).toBe('icm');
    });

    // The vocabulary is OPEN: prod holds ICM, ISMIN and Master, and the next one arrives from
    // Authentik with no deploy. It must land somewhere priced rather than nowhere.
    it('places an unforeseen formation in "everyone else"', () => {
      expect(bucketFor(dimension, facts({ formation: 'DoctoratQuiNexistePas' }))).toBe(
        OTHERS_BUCKET_ID
      );
    });

    it('places a submitter with no formation in "everyone else"', () => {
      expect(bucketFor(dimension, facts({ formation: null }))).toBe(OTHERS_BUCKET_ID);
    });
  });

  describe('answer', () => {
    const dimension: Dimension = {
      id: 'd1',
      kind: 'answer',
      questionId: 'q_menu',
      buckets: [
        { id: 'veg', label: 'Menu vegetarien', values: ['opt_veg'] },
        { id: 'meat', label: 'Menu viande', values: ['opt_meat'] },
      ],
    };

    it('matches the selected option', () => {
      expect(bucketFor(dimension, facts({ answers: { q_menu: ['opt_meat'] } }))).toBe('meat');
    });

    it('places an unanswered question in "everyone else"', () => {
      expect(bucketFor(dimension, facts())).toBe(OTHERS_BUCKET_ID);
    });

    it('matches when one of several selections is in the group', () => {
      expect(bucketFor(dimension, facts({ answers: { q_menu: ['opt_x', 'opt_veg'] } }))).toBe('veg');
    });
  });

  describe('a condition ANDs its criteria', () => {
    const condition = {
      formation: { values: ['ICM'] },
      promo: { mode: 'graduationYear' as const, values: [2028] },
    };

    it('accepts a submitter matching every criterion', () => {
      expect(matchesCondition(condition, facts({ formation: 'ICM', promo: 2028 }))).toBe(true);
    });

    it('refuses a submitter matching only one', () => {
      expect(matchesCondition(condition, facts({ formation: 'ICM', promo: 2029 }))).toBe(false);
      expect(matchesCondition(condition, facts({ formation: 'ISMIN', promo: 2028 }))).toBe(false);
    });

    // An absent criterion is no constraint - not an empty one that matches nobody.
    it('ignores a criterion that is not present', () => {
      expect(matchesCondition({ formation: { values: ['ICM'] } }, facts({ formation: 'ICM' }))).toBe(
        true
      );
    });
  });

  // A form pricing only on cotisation tiers or answers must not be blocked by a service it does not
  // need, so the question is asked before any fetch.
  describe('needsProfile', () => {
    it('is true only for a promo or formation criterion', () => {
      expect(needsProfile({ promo: { mode: 'graduationYear', values: [2028] } })).toBe(true);
      expect(needsProfile({ formation: { values: ['ICM'] } })).toBe(true);
      expect(needsProfile({ cotisation: { anyTier: true } })).toBe(false);
      expect(needsProfile({ answer: { questionId: 'q', optionIds: ['o'] } })).toBe(false);
      expect(needsProfile(null)).toBe(false);
    });
  });

  // Overlap is what would force a priority rule, so it is found at save time rather than resolved
  // at price time.
  describe('findOverlappingBuckets', () => {
    it('finds two groups sharing a value', () => {
      const d: Dimension = {
        id: 'd1',
        kind: 'formation',
        buckets: [
          { id: 'a', label: 'A', values: ['ICM', 'ISMIN'] },
          { id: 'b', label: 'B', values: ['ISMIN'] },
        ],
      };
      expect(findOverlappingBuckets(d)).toEqual([['a', 'b']]);
    });

    it('accepts disjoint groups', () => {
      const d: Dimension = {
        id: 'd1',
        kind: 'formation',
        buckets: [
          { id: 'a', label: 'A', values: ['ICM'] },
          { id: 'b', label: 'B', values: ['ISMIN'] },
        ],
      };
      expect(findOverlappingBuckets(d)).toEqual([]);
    });

    // Set intersection cannot see this one: "any tier" contains every specific tier, so a grid with
    // both would put a "sans-alcool" cotisant in whichever came first.
    it('finds an "any tier" group swallowing a specific one', () => {
      const d: Dimension = {
        id: 'd1',
        kind: 'cotisation',
        buckets: [
          { id: 'any', label: 'Cotisant', anyTier: true },
          { id: 'one', label: 'Sans alcool', variantKeys: ['sans-alcool'] },
        ],
      };
      expect(findOverlappingBuckets(d)).toEqual([['any', 'one']]);
    });
  });
});
