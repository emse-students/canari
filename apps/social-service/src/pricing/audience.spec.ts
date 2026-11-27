import {
  bucketFor,
  cheapestCursus,
  cursusViews,
  describeCursus,
  failedCriterion,
  findOverlappingBuckets,
  matchesCondition,
  needsProfile,
  NO_CURSUS,
  OTHERS_BUCKET_ID,
  type Dimension,
} from './audience';
import { factsOf, viewOf } from './facts.it-fixture';

/**
 * The one predicate behind a price, a question's visibility and who may submit.
 *
 * NOTHING HERE READS A CLOCK, and that is a property rather than an omission: a promo is an entry
 * year and names one cohort for ever, so no answer below can change with the day it is run. The
 * predicate used to take a `now` for `yearsToGraduation`, which is gone.
 */
describe('audience predicate', () => {
  const facts = factsOf;
  const view = viewOf;

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
      expect(bucketFor(dimension, view({ cotisationTiers: ['avec-alcool'] }))).toBe('alcool');
    });

    // `null` is the base tier, a value like any other - not a missing one.
    it('treats the base tier as a tier', () => {
      expect(bucketFor(dimension, view({ cotisationTiers: [null] }))).toBe('base');
    });

    it('places a non-cotisant in "everyone else"', () => {
      expect(bucketFor(dimension, view())).toBe(OTHERS_BUCKET_ID);
    });

    // The whole point of storing a REFERENCE: a tier created after the form was saved still counts
    // as a cotisation, where a stored list of tier keys would have dropped them into `others`.
    it('accepts a tier the form never named, when the group takes any tier', () => {
      const anyTier: Dimension = {
        id: 'd1',
        kind: 'cotisation',
        buckets: [{ id: 'cot', label: 'Cotisant', anyTier: true }],
      };
      expect(bucketFor(anyTier, view({ cotisationTiers: ['invented-last-week'] }))).toBe('cot');
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
      expect(bucketFor(dimension, view({ promo: 2024 }))).toBe('p2024');
    });

    // A group is a SET of years, which is how "les 3A et plus" is expressed without a relative mode.
    it('matches any of the years a group names', () => {
      expect(bucketFor(dimension, view({ promo: 2022 }))).toBe('anciens');
      expect(bucketFor(dimension, view({ promo: 2023 }))).toBe('anciens');
    });

    it('places a promo no group names in "everyone else"', () => {
      expect(bucketFor(dimension, view({ promo: 2025 }))).toBe(OTHERS_BUCKET_ID);
    });

    // 5 users on prod have no promo. Treating a missing value as a year would price somebody on the
    // strength of a blank field.
    it('places a submitter with no promo in "everyone else"', () => {
      expect(bucketFor(dimension, view({ promo: null }))).toBe(OTHERS_BUCKET_ID);
    });
  });

  describe('formation', () => {
    const dimension: Dimension = {
      id: 'd1',
      kind: 'formation',
      buckets: [{ id: 'icm', label: 'ICM', values: ['ICM'] }],
    };

    it('matches a listed formation', () => {
      expect(bucketFor(dimension, view({ formation: 'ICM' }))).toBe('icm');
    });

    // The vocabulary is OPEN: prod holds ICM, ISMIN and Master, and the next one arrives from
    // Authentik with no deploy. It must land somewhere priced rather than nowhere.
    it('places an unforeseen formation in "everyone else"', () => {
      expect(bucketFor(dimension, view({ formation: 'DoctoratQuiNexistePas' }))).toBe(
        OTHERS_BUCKET_ID
      );
    });

    it('places a submitter with no formation in "everyone else"', () => {
      expect(bucketFor(dimension, view({ formation: null }))).toBe(OTHERS_BUCKET_ID);
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
      expect(bucketFor(dimension, view({ answers: { q_menu: ['opt_meat'] } }))).toBe('meat');
    });

    it('places an unanswered question in "everyone else"', () => {
      expect(bucketFor(dimension, view())).toBe(OTHERS_BUCKET_ID);
    });

    it('matches when one of several selections is in the group', () => {
      expect(bucketFor(dimension, view({ answers: { q_menu: ['opt_x', 'opt_veg'] } }))).toBe('veg');
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

  // Owner, 2026-10-30: "ne detient pas" - nobody pays a cotisation twice.
  describe('notCotisation', () => {
    const notBde = { notCotisation: { variantKeys: ['bde'] } };

    it('refuses a holder of a named tier and admits everybody else', () => {
      expect(failedCriterion(notBde, facts({ cotisationTiers: ['bde'] }))).toBe('notCotisation');
      expect(matchesCondition(notBde, facts())).toBe(true);
      expect(matchesCondition(notBde, facts({ cotisationTiers: ['other'] }))).toBe(true);
    });

    it('names the base tier by null, a value and not a missing one', () => {
      const notBase = { notCotisation: { variantKeys: [null] } };
      expect(matchesCondition(notBase, facts({ cotisationTiers: [null] }))).toBe(false);
      expect(matchesCondition(notBase, facts({ cotisationTiers: ['bde'] }))).toBe(true);
    });

    it('anyTier refuses a holder of any tier', () => {
      const none = { notCotisation: { anyTier: true } };
      expect(matchesCondition(none, facts({ cotisationTiers: ['x'] }))).toBe(false);
      expect(matchesCondition(none, facts())).toBe(true);
    });

    // The refusal names it whenever it fails, so the typed "you already hold it" is never masked by
    // another failing criterion of the same condition.
    it('is the criterion reported first when several fail', () => {
      const both = { promo: { values: [2028] }, ...notBde };
      expect(failedCriterion(both, facts({ promo: 2020, cotisationTiers: ['bde'] }))).toBe(
        'notCotisation'
      );
      expect(failedCriterion(both, facts({ promo: 2020 }))).toBe('promo');
    });

    it('needs no identity-provider profile', () => {
      expect(needsProfile({ notCotisation: { anyTier: true } })).toBe(false);
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

  // D32 (profiles-and-access.md): two cursus pay the most favourable price, and a question or a
  // submission open to either is open. Each case below failed when only the FIRST cursus was read.
  describe('two cursus (D32)', () => {
    const icmSecond = facts({
      cursus: [
        { formation: 'ISMIN', promo: 2022 },
        { formation: 'ICM', promo: 2024 },
      ],
    });

    it('holds a condition through the second cursus - formation and promo alike', () => {
      expect(matchesCondition({ formation: { values: ['ICM'] } }, icmSecond)).toBe(true);
      expect(matchesCondition({ promo: { values: [2024] } }, icmSecond)).toBe(true);
      expect(failedCriterion({ formation: { values: ['ICM'] } }, icmSecond)).toBeNull();
    });

    it('never pairs the promo of one cursus with the formation of another', () => {
      // ICM 2024 and ISMIN 2022: "ICM 2022" is neither of them.
      expect(
        matchesCondition({ formation: { values: ['ICM'] }, promo: { values: [2022] } }, icmSecond)
      ).toBe(false);
      expect(
        matchesCondition({ formation: { values: ['ICM'] }, promo: { values: [2024] } }, icmSecond)
      ).toBe(true);
    });

    it('names the FIRST cursus criterion when no cursus holds, and notCotisation first', () => {
      const condition = { formation: { values: ['FISA'] }, promo: { values: [2022] } };
      // First cursus (ISMIN 2022) fails on formation; the second (ICM 2024) would say promo.
      expect(failedCriterion(condition, icmSecond)).toBe('formation');
      const held = { ...icmSecond, cotisationTiers: ['bde'] };
      expect(failedCriterion({ ...condition, notCotisation: { variantKeys: ['bde'] } }, held)).toBe(
        'notCotisation'
      );
    });

    it('reads a bucket through each cursus on its own', () => {
      const dimension: Dimension = {
        id: 'd1',
        kind: 'formation',
        buckets: [{ id: 'icm', label: 'ICM', values: ['ICM'] }],
      };
      expect(cursusViews(icmSecond).map((v) => bucketFor(dimension, v))).toEqual([
        OTHERS_BUCKET_ID,
        'icm',
      ]);
    });

    it('a person with no cursus is one empty view, exactly as before', () => {
      const none = facts({ cursus: NO_CURSUS });
      expect(cursusViews(none)).toHaveLength(1);
      expect(matchesCondition({ formation: { values: ['ICM'] } }, none)).toBe(false);
      expect(failedCriterion({ promo: { values: [2024] } }, none)).toBe('promo');
      expect(matchesCondition({}, none)).toBe(true);
    });

    it('refuses facts with an empty cursus list: NO_CURSUS is how "none" is said', () => {
      expect(() => cursusViews(facts({ cursus: [] }))).toThrow(/no cursus view/);
    });
  });

  describe('cheapestCursus (D32)', () => {
    const three = facts({
      cursus: [
        { formation: 'A', promo: 2020 },
        { formation: 'B', promo: 2021 },
        { formation: 'C', promo: 2022 },
      ],
    });
    const priceBy = (table: Record<string, number | null>) => (v: { formation: string | null }) =>
      table[v.formation as string];

    it('picks the cheapest total, wherever it sits', () => {
      const choice = cheapestCursus(three, priceBy({ A: 900, B: 700, C: 800 }), (c) => c);
      expect(choice.index).toBe(1);
      expect(choice.view.formation).toBe('B');
      expect(choice.cents).toBe(700);
    });

    it('gives a tie to the first cursus', () => {
      expect(cheapestCursus(three, priceBy({ A: 900, B: 500, C: 500 }), (c) => c).index).toBe(1);
      expect(cheapestCursus(three, priceBy({ A: 500, B: 500, C: 500 }), (c) => c).index).toBe(0);
    });

    it('an unavailable combination loses to any price, even a dearer one', () => {
      expect(cheapestCursus(three, priceBy({ A: null, B: 9000, C: null }), (c) => c).index).toBe(1);
    });

    it('returns the first cursus with no price when every combination is unavailable', () => {
      const choice = cheapestCursus(three, priceBy({ A: null, B: null, C: null }), (c) => c);
      expect(choice.index).toBe(0);
      expect(choice.cents).toBeNull();
    });

    it('describes the winner by formation and promo only', () => {
      const choice = cheapestCursus(three, priceBy({ A: 3, B: 2, C: 1 }), (c) => c);
      expect(describeCursus(choice)).toBe('cursus=3/3 formation=C promo=2022');
    });
  });
});
