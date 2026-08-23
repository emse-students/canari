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
 * NOTHING HERE READS A CLOCK, and that is a property rather than an omission: a promo is an entry
 * year and names one cohort for ever, so no answer below can change with the day it is run. The
 * predicate used to take a `now` for `yearsToGraduation`, which is gone.
 */
describe('audience predicate', () => {
  const facts = (over: Partial<SubmitterFacts> = {}): SubmitterFacts => ({
    promo: null,
    formation: null,
    cotisationTiers: [],
    answers: {},
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

  // A promo is an ENTRY year: "la promo 2024" is the cohort that entered the school in 2024. The
  // manager names the group ("2A"), the group names its years, and neither goes stale on its own.
  describe('promo', () => {
    const dimension: Dimension = {
      id: 'd1',
      kind: 'promo',
      buckets: [
        { id: 'p2024', label: '2A', values: [2024] },
        { id: 'anciens', label: 'Anciens', values: [2022, 2023] },
      ],
    };

    it('matches the entry year a group names', () => {
      expect(bucketFor(dimension, facts({ promo: 2024 }))).toBe('p2024');
    });

    // A group is a SET of years, which is how "les 3A et plus" is expressed without a relative mode.
    it('matches any of the years a group names', () => {
      expect(bucketFor(dimension, facts({ promo: 2022 }))).toBe('anciens');
      expect(bucketFor(dimension, facts({ promo: 2023 }))).toBe('anciens');
    });

    it('places a promo no group names in "everyone else"', () => {
      expect(bucketFor(dimension, facts({ promo: 2025 }))).toBe(OTHERS_BUCKET_ID);
    });

    // 5 users on prod have no promo. Treating a missing value as a year would price somebody on the
    // strength of a blank field.
    it('places a submitter with no promo in "everyone else"', () => {
      expect(bucketFor(dimension, facts({ promo: null }))).toBe(OTHERS_BUCKET_ID);
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
      expect(bucketFor(dimension, facts({ answers: { q_menu: ['opt_x', 'opt_veg'] } }))).toBe(
        'veg'
      );
    });
  });

  describe('a condition ANDs its criteria', () => {
    const condition = {
      formation: { values: ['ICM'] },
      promo: { values: [2028] },
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
      expect(
        matchesCondition({ formation: { values: ['ICM'] } }, facts({ formation: 'ICM' }))
      ).toBe(true);
    });
  });

  // A form pricing only on cotisation tiers or answers must not be blocked by a service it does not
  // need, so the question is asked before any fetch.
  describe('needsProfile', () => {
    it('is true only for a promo or formation criterion', () => {
      expect(needsProfile({ promo: { values: [2028] } })).toBe(true);
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
