import type { MembershipTier } from '$lib/associations/api';
import type { FormItem } from '$lib/forms/api';
import { m } from '$lib/paraglide/messages';
import { promoYears } from './criteriaOptions';
import type { Bucket, Dimension } from './priceMatrix';
import type { FormationOption } from './criteriaOptions';

/**
 * What a criterion's groups hold, as the chips and the "+" suggestions show it.
 *
 * One place for the four kinds, so the chip on a group, the suggestion that adds it and the line
 * under a row header of the price table name a value the same way - a tier by its NAME, an option
 * by its label, never an id.
 */

/** The lists a criterion's values are drawn from. */
export interface CriterionSources {
  tiers: MembershipTier[];
  formations: FormationOption[];
  items: FormItem[];
}

/**
 * One value a group can hold. `value` is what the bucket stores (a year, a formation, an option id,
 * a tier key with `null` for the base tier); `ANY_TIER` stands for the cotisation "any tier" flag.
 */
export interface CriterionValue {
  value: string | number | null | typeof ANY_TIER;
  label: string;
}

/** The cotisation group's "any tier the association sells" flag, carried as a value. */
export const ANY_TIER = Symbol('anyTier');

/** How many recent promos the "+" offers; an older year is typed. */
export const PROMO_SUGGESTIONS = 6;

function tierName(key: string | null, tiers: MembershipTier[]): string {
  return tiers.find((t) => t.variantKey === key)?.name ?? m.form_cotisation_tier_base();
}

/** The values one group holds, labelled. */
export function bucketValues(
  dimension: Dimension,
  bucket: Bucket,
  sources: CriterionSources
): CriterionValue[] {
  if (dimension.kind === 'cotisation') {
    if (bucket.anyTier) return [{ value: ANY_TIER, label: m.form_criterion_any_tier() }];
    return (bucket.variantKeys ?? []).map((k) => ({ value: k, label: tierName(k, sources.tiers) }));
  }
  const values = bucket.values ?? [];
  if (dimension.kind === 'promo') {
    return [...values]
      .sort((a, b) => Number(b) - Number(a))
      .map((v) => ({ value: v, label: String(v) }));
  }
  if (dimension.kind === 'answer') {
    const options = sources.items.find((i) => i.id === dimension.questionId)?.options ?? [];
    return values.map((v) => ({
      value: v,
      label: options.find((o) => o.id === v)?.label ?? String(v),
    }));
  }
  return values.map((v) => ({ value: v, label: String(v) }));
}

/** The labels of one group's values, joined - the line under a row header. */
export function bucketSummary(
  dimension: Dimension,
  bucket: Bucket,
  sources: CriterionSources
): string {
  return bucketValues(dimension, bucket, sources)
    .map((v) => v.label)
    .join(', ');
}

/**
 * Whether this criterion may hold only ONE group: it divides on a MULTIPLE-choice question. A
 * person can tick options of two groups, and the first group in the grid's order would win, so the
 * price would depend on that order; the server refuses such a grid at save
 * (`assertMultipleChoiceGridOneGroup`), and the editor stops offering a second group instead.
 */
export function takesOneGroup(dimension: Dimension, items: readonly FormItem[]): boolean {
  if (dimension.kind !== 'answer' || !dimension.questionId) return false;
  return items.find((i) => i.id === dimension.questionId)?.type === 'multiple_choice';
}

/**
 * The values the "+" of a group offers: those NO group of the criterion holds yet, because the
 * server refuses two groups that overlap. A promo is a year from 1816, so only the most recent
 * unplaced ones are offered; an older year is typed.
 */
export function remainingValues(dimension: Dimension, sources: CriterionSources): CriterionValue[] {
  if (dimension.kind === 'cotisation') {
    const placed = new Set(dimension.buckets.flatMap((b) => b.variantKeys ?? []));
    const anyTaken = dimension.buckets.some((b) => b.anyTier);
    const any: CriterionValue[] = anyTaken
      ? []
      : [{ value: ANY_TIER, label: m.form_criterion_any_tier() }];
    return [
      ...any,
      ...sources.tiers
        .filter((t) => !placed.has(t.variantKey))
        .map((t) => ({ value: t.variantKey, label: t.name })),
    ];
  }
  const placed = new Set(dimension.buckets.flatMap((b) => b.values ?? []).map(String));
  if (dimension.kind === 'promo') {
    return promoYears()
      .filter((y) => !placed.has(String(y)))
      .slice(0, PROMO_SUGGESTIONS)
      .map((y) => ({ value: y, label: String(y) }));
  }
  if (dimension.kind === 'formation') {
    return sources.formations
      .filter((f) => !placed.has(f.value))
      .map((f) => ({ value: f.value, label: f.value }));
  }
  const options = sources.items.find((i) => i.id === dimension.questionId)?.options ?? [];
  return options
    .filter((o) => o.id && !placed.has(o.id))
    .map((o) => ({ value: o.id as string, label: o.label }));
}

/** Adds one value to a group, in place - the caller reassigns the grid so Svelte sees it. */
export function addBucketValue(
  dimension: Dimension,
  bucket: Bucket,
  value: CriterionValue['value']
) {
  if (dimension.kind === 'cotisation') {
    if (value === ANY_TIER) {
      bucket.anyTier = true;
      bucket.variantKeys = [];
    } else {
      bucket.anyTier = false;
      bucket.variantKeys = [...(bucket.variantKeys ?? []), value as string | null];
    }
    return;
  }
  bucket.values = [...(bucket.values ?? []), value as string | number];
}

/** Removes one value from a group, in place. */
export function removeBucketValue(
  dimension: Dimension,
  bucket: Bucket,
  value: CriterionValue['value']
) {
  if (dimension.kind === 'cotisation') {
    if (value === ANY_TIER) bucket.anyTier = false;
    else bucket.variantKeys = (bucket.variantKeys ?? []).filter((k) => k !== value);
    return;
  }
  bucket.values = (bucket.values ?? []).filter((v) => v !== value);
}
