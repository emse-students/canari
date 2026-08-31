/**
 * The audience predicate: who a person is, and whether they fall in a given bucket.
 *
 * ONE predicate serves the three things a form does with the same criteria - what a submitter pays
 * (a cell of the price matrix), whether a question is shown to them, and whether they may submit at
 * all. Writing it three times is how the three drift apart, and a price that disagrees with the
 * question that set it is not a bug anyone reports clearly.
 */

/** Everything a criterion may look at. Assembled once per request, never re-fetched per bucket. */
export interface PricingFacts {
  /** ENTRY year from the identity provider - "la promo 2024" entered in 2024. Null when unset. */
  promo: number | null;
  /** Formation/track from the identity provider; null when unset. */
  formation: string | null;
  /**
   * The cotisation tiers this submitter currently holds for the form's association, by
   * `variantKey` - `null` being the base, un-suffixed tier. Empty when they hold none.
   */
  cotisationTiers: (string | null)[];
  /** Answers, by question id, as the option ids selected. A free-text answer contributes nothing. */
  answers: Record<string, string[]>;
}

interface BucketBase {
  /** Stable id, used in a cell key. Never displayed. */
  id: string;
  /** What a person reads when the form tells them which price applies - "Cotisant 1A". */
  label: string;
}

/**
 * Cotisation bucket. `anyTier` is a REFERENCE to "whatever this association sells", not the list of
 * tiers at the time the form was saved - listing them would drop a cotisant of a tier created later
 * into `others`, which is migration 050's lesson in a new place.
 */
export interface CotisationBucket extends BucketBase {
  anyTier?: boolean;
  /** Specific tiers; `null` is the base tier. Ignored when `anyTier` is set. */
  variantKeys?: (string | null)[];
}

/** Promo bucket: a set of entry years. */
export interface PromoBucket extends BucketBase {
  values: number[];
}

/** Formation or answer bucket: a set of formation strings, or a set of option ids. */
export interface StringBucket extends BucketBase {
  values: string[];
}

/**
 * A PROMO IS AN ENTRY YEAR, not a graduation year: "la promo 2024" is the cohort that entered the
 * school in 2024. It names one cohort for ever, so there is exactly one way to express it and no
 * mode to choose.
 *
 * There was a second way, `yearsToGraduation`, read as `promo - academicEndYear`. It rested on the
 * graduation reading and was therefore wrong for EVERYBODY: for the promo 2025 evaluated in 2026 it
 * yielded -1, and the editor only ever offered 0..4, so that mode matched nobody it was ever set
 * for. A relative mode cannot be made correct either - it needs a cursus length and nothing in this
 * platform records one (ICM and ISMIN run three years, Master two). So a bucket names its years and
 * the manager names the bucket ("1A").
 */

/** A dimension of the price matrix: a partition of the population into buckets. */
export type Dimension =
  | { id: string; kind: 'cotisation'; buckets: CotisationBucket[] }
  | { id: string; kind: 'promo'; buckets: PromoBucket[] }
  | { id: string; kind: 'formation'; buckets: StringBucket[] }
  | { id: string; kind: 'answer'; questionId: string; buckets: StringBucket[] };

/**
 * The generated bucket every dimension ends with.
 *
 * It is generated, never stored, and cannot be deleted: it is what makes a dimension a PARTITION
 * rather than a filter, and therefore what guarantees no submitter is ever unpriced. A null
 * formation, a track the school invents next year, a non-cotisant, a promo outside every bucket and
 * an unanswered question all land here.
 */
export const OTHERS_BUCKET_ID = '_others';

/**
 * A criterion used on its own rather than as a matrix dimension - for a question's visibility and
 * for who may submit. AND across the keys present; a key absent is no constraint at all.
 *
 * Same bucket shapes as a dimension, so the matchers below are the only implementation.
 */
export interface AudienceCondition {
  cotisation?: Pick<CotisationBucket, 'anyTier' | 'variantKeys'>;
  promo?: { values: number[] };
  formation?: { values: string[] };
  /** The generalisation of `dependsOn`/`dependsValue`: this question has one of these options. */
  answer?: { questionId: string; optionIds: string[] };
}

/** True when the submitter holds a cotisation the bucket accepts. */
function matchesCotisation(
  bucket: Pick<CotisationBucket, 'anyTier' | 'variantKeys'>,
  facts: PricingFacts
): boolean {
  if (facts.cotisationTiers.length === 0) return false;
  if (bucket.anyTier) return true;
  const wanted = bucket.variantKeys ?? [];
  return facts.cotisationTiers.some((held) => wanted.includes(held));
}

/**
 * True when the submitter's entry year is one of the bucket's.
 *
 * A null promo matches nothing - it is not a year, and treating it as one would put somebody in a
 * priced cell on the strength of a missing value.
 */
function matchesPromo(values: number[], facts: PricingFacts): boolean {
  return facts.promo !== null && values.includes(facts.promo);
}

/** True when the submitter's formation is one of the bucket's values. Case-sensitive, as stored. */
function matchesFormation(values: string[], facts: PricingFacts): boolean {
  return facts.formation !== null && values.includes(facts.formation);
}

/** True when the submitter selected one of the bucket's options for that question. */
function matchesAnswer(questionId: string, optionIds: string[], facts: PricingFacts): boolean {
  const selected = facts.answers[questionId];
  if (!selected?.length) return false;
  return selected.some((id) => optionIds.includes(id));
}

/**
 * Which bucket of `dimension` the submitter falls in - always exactly one, `OTHERS_BUCKET_ID` when
 * no declared bucket claims them.
 *
 * The first matching bucket wins, and that is not a priority rule to reason about: the editor
 * refuses overlapping buckets within a dimension (`findOverlappingBuckets`), so at most one can
 * ever match. First-match is how the loop ends, not how ties are broken.
 */
export function bucketFor(dimension: Dimension, facts: PricingFacts): string {
  switch (dimension.kind) {
    case 'cotisation':
      return dimension.buckets.find((b) => matchesCotisation(b, facts))?.id ?? OTHERS_BUCKET_ID;
    case 'promo':
      return dimension.buckets.find((b) => matchesPromo(b.values, facts))?.id ?? OTHERS_BUCKET_ID;
    case 'formation':
      return (
        dimension.buckets.find((b) => matchesFormation(b.values, facts))?.id ?? OTHERS_BUCKET_ID
      );
    case 'answer':
      return (
        dimension.buckets.find((b) => matchesAnswer(dimension.questionId, b.values, facts))?.id ??
        OTHERS_BUCKET_ID
      );
  }
}

/** True when the submitter satisfies every criterion present in the condition. */
export function matchesCondition(condition: AudienceCondition, facts: PricingFacts): boolean {
  if (condition.cotisation && !matchesCotisation(condition.cotisation, facts)) return false;
  if (condition.promo && !matchesPromo(condition.promo.values, facts)) return false;
  if (condition.formation && !matchesFormation(condition.formation.values, facts)) return false;
  if (
    condition.answer &&
    !matchesAnswer(condition.answer.questionId, condition.answer.optionIds, facts)
  )
    return false;
  return true;
}

/**
 * Whether a condition needs an identity-provider attribute, and therefore a call to core-service.
 *
 * Asked before every fetch: a form pricing only on cotisation tiers and answers must not fail
 * because a service it does not need is down.
 */
export function needsProfile(condition: AudienceCondition | null | undefined): boolean {
  return !!condition && (!!condition.promo || !!condition.formation);
}

/** Whether any dimension needs an identity-provider attribute. Same question, for a matrix. */
export function dimensionsNeedProfile(dimensions: Dimension[]): boolean {
  return dimensions.some((d) => d.kind === 'promo' || d.kind === 'formation');
}

/**
 * Buckets of one dimension that can both claim the same person, as `[bucketId, bucketId]` pairs.
 *
 * Overlap is refused at save time rather than resolved at price time: two buckets claiming one
 * submitter means the cell they land in depends on bucket order, and an order that decides money is
 * exactly the priority rule this design exists to not have. Cotisation is the one kind where
 * overlap cannot be decided by set intersection - `anyTier` contains every specific tier - so it is
 * checked explicitly.
 */
export function findOverlappingBuckets(dimension: Dimension): [string, string][] {
  const clashes: [string, string][] = [];
  const buckets = dimension.buckets;
  for (let i = 0; i < buckets.length; i++) {
    for (let j = i + 1; j < buckets.length; j++) {
      const a = buckets[i];
      const b = buckets[j];
      let overlaps: boolean;
      if (dimension.kind === 'cotisation') {
        const ca = a as CotisationBucket;
        const cb = b as CotisationBucket;
        overlaps =
          !!ca.anyTier ||
          !!cb.anyTier ||
          (ca.variantKeys ?? []).some((k) => (cb.variantKeys ?? []).includes(k));
      } else {
        const va = (a as { values: (string | number)[] }).values ?? [];
        const vb = (b as { values: (string | number)[] }).values ?? [];
        overlaps = va.some((v) => vb.includes(v));
      }
      if (overlaps) clashes.push([a.id, b.id]);
    }
  }
  return clashes;
}
