import { BadRequestException } from '@nestjs/common';
import { OTHERS_BUCKET_ID, type AudienceCondition, type Dimension } from './audience';
import { assertMatrixValid, type PriceMatrix } from './price-matrix';

/**
 * Turns the untyped documents a client sends into the typed criteria this module evaluates, or
 * refuses them.
 *
 * Structural validation lives here rather than in nested class-validator DTOs: a criterion is a
 * small discriminated document whose validity depends on things a decorator cannot see - the
 * association's own cotisation tiers, and the ids of the questions in the very form being saved. A
 * `@ValidateNested` tree over four optional shapes would still need this function, and then there
 * would be two places to keep in step.
 *
 * Every refusal below is a submitter who would otherwise have had no price, a criterion that
 * silently matches nobody, or a price decided by the order of two groups.
 */
export interface CriteriaContext {
  /** `variantKey`s the beneficiary association sells; `null` is the base tier. */
  tierKeys: (string | null)[];
  /** The form's questions and the option ids each offers. */
  questions: Map<string, Set<string>>;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new BadRequestException(`${where} must be a list of strings.`);
  }
  if (value.length === 0) throw new BadRequestException(`${where} cannot be empty.`);
  return value as string[];
}

/** Cotisation keys: strings, or `null` for the base tier - which is a value, not a missing one. */
function asTierKeys(value: unknown, where: string, ctx: CriteriaContext): (string | null)[] {
  if (!Array.isArray(value) || value.some((v) => v !== null && typeof v !== 'string')) {
    throw new BadRequestException(`${where} must be a list of cotisation tiers.`);
  }
  if (value.length === 0) throw new BadRequestException(`${where} cannot be empty.`);
  const keys = value as (string | null)[];
  for (const key of keys) {
    if (!ctx.tierKeys.some((k) => k === key)) {
      throw new BadRequestException(
        key
          ? `Unknown cotisation tier "${key}" for this association.`
          : 'This association has no base cotisation tier, so a tier must be named.'
      );
    }
  }
  return keys;
}

/**
 * A promo is an ENTRY year, bounded by the school's founding year and today.
 *
 * The bounds are not decoration: a promo outside them matches nobody, for ever, and a criterion
 * that silently matches nobody is exactly what this module refuses. `2O24` typed for `2024` is the
 * realistic way one is written, and it would price a whole cohort as "everyone else" in silence.
 */
export const FIRST_PROMO_YEAR = 1816;

function asPromoValues(value: unknown, where: string, now: Date = new Date()): number[] {
  if (!Array.isArray(value) || value.some((v) => !Number.isInteger(v))) {
    throw new BadRequestException(`${where} must be a list of whole years.`);
  }
  if (value.length === 0) throw new BadRequestException(`${where} cannot be empty.`);
  const lastYear = now.getFullYear();
  for (const year of value as number[]) {
    if (year < FIRST_PROMO_YEAR || year > lastYear) {
      throw new BadRequestException(
        `${where} holds ${year}, which is not a promo: they run from ${FIRST_PROMO_YEAR} to ${lastYear}.`
      );
    }
  }
  return value as number[];
}

/** A cotisation criterion needs the association to actually sell a cotisation. */
function assertSellsCotisation(ctx: CriteriaContext, where: string): void {
  if (ctx.tierKeys.length === 0) {
    throw new BadRequestException(
      `${where} refers to a cotisation, but this association has none: enable it and add a tier first.`
    );
  }
}

/** Validates and normalises one condition - a question's visibility, or who may submit. */
export function parseAudienceCondition(
  raw: unknown,
  ctx: CriteriaContext,
  where: string
): AudienceCondition {
  const doc = asRecord(raw, where);
  const condition: AudienceCondition = {};

  if (doc.cotisation !== undefined) {
    const c = asRecord(doc.cotisation, `${where}.cotisation`);
    assertSellsCotisation(ctx, `${where}.cotisation`);
    if (c.anyTier === true) condition.cotisation = { anyTier: true };
    else
      condition.cotisation = {
        variantKeys: asTierKeys(c.variantKeys, `${where}.cotisation.variantKeys`, ctx),
      };
  }
  if (doc.promo !== undefined) {
    const p = asRecord(doc.promo, `${where}.promo`);
    condition.promo = { values: asPromoValues(p.values, `${where}.promo.values`) };
  }
  if (doc.formation !== undefined) {
    const f = asRecord(doc.formation, `${where}.formation`);
    condition.formation = { values: asStringArray(f.values, `${where}.formation.values`) };
  }
  if (doc.answer !== undefined) {
    const a = asRecord(doc.answer, `${where}.answer`);
    const questionId = typeof a.questionId === 'string' ? a.questionId : '';
    const options = ctx.questions.get(questionId);
    if (!options) {
      throw new BadRequestException(`${where}.answer names a question that is not in this form.`);
    }
    const optionIds = asStringArray(a.optionIds, `${where}.answer.optionIds`);
    for (const id of optionIds) {
      if (!options.has(id)) {
        throw new BadRequestException(
          `${where}.answer names an option that question does not offer.`
        );
      }
    }
    condition.answer = { questionId, optionIds };
  }

  if (Object.keys(condition).length === 0) {
    throw new BadRequestException(
      `${where} has no criterion, so it would apply to everybody. Remove it instead.`
    );
  }
  return condition;
}

/** Validates and normalises one dimension of the grid. */
function parseDimension(raw: unknown, ctx: CriteriaContext, index: number): Dimension {
  const where = `priceMatrix.dimensions[${index}]`;
  const doc = asRecord(raw, where);
  const id = typeof doc.id === 'string' && doc.id.trim() ? doc.id : '';
  if (!id) throw new BadRequestException(`${where}.id is required.`);
  if (!Array.isArray(doc.buckets)) {
    throw new BadRequestException(`${where}.buckets must be a list.`);
  }

  const base = (raw: unknown, i: number) => {
    const b = asRecord(raw, `${where}.buckets[${i}]`);
    const bucketId = typeof b.id === 'string' && b.id.trim() ? b.id : '';
    if (!bucketId) throw new BadRequestException(`${where}.buckets[${i}].id is required.`);
    if (bucketId === OTHERS_BUCKET_ID) {
      throw new BadRequestException(
        `"${OTHERS_BUCKET_ID}" is reserved: every criterion already ends with an "everyone else" group.`
      );
    }
    const label = typeof b.label === 'string' ? b.label.trim() : '';
    if (!label) throw new BadRequestException(`${where}.buckets[${i}].label is required.`);
    return { doc: b, id: bucketId, label };
  };

  switch (doc.kind) {
    case 'cotisation': {
      assertSellsCotisation(ctx, where);
      return {
        id,
        kind: 'cotisation',
        buckets: doc.buckets.map((raw, i) => {
          const { doc: b, id: bucketId, label } = base(raw, i);
          return b.anyTier === true
            ? { id: bucketId, label, anyTier: true }
            : {
                id: bucketId,
                label,
                variantKeys: asTierKeys(b.variantKeys, `${where}.buckets[${i}].variantKeys`, ctx),
              };
        }),
      };
    }
    case 'promo': {
      return {
        id,
        kind: 'promo',
        buckets: doc.buckets.map((raw, i) => {
          const { doc: b, id: bucketId, label } = base(raw, i);
          return {
            id: bucketId,
            label,
            values: asPromoValues(b.values, `${where}.buckets[${i}].values`),
          };
        }),
      };
    }
    case 'formation':
      return {
        id,
        kind: 'formation',
        buckets: doc.buckets.map((raw, i) => {
          const { doc: b, id: bucketId, label } = base(raw, i);
          return {
            id: bucketId,
            label,
            values: asStringArray(b.values, `${where}.buckets[${i}].values`),
          };
        }),
      };
    case 'answer': {
      const questionId = typeof doc.questionId === 'string' ? doc.questionId : '';
      const options = ctx.questions.get(questionId);
      if (!options) {
        throw new BadRequestException(`${where}.questionId is not a question of this form.`);
      }
      if (options.size === 0) {
        throw new BadRequestException(
          `${where} prices on a question that offers no options, so it separates nobody.`
        );
      }
      return {
        id,
        kind: 'answer',
        questionId,
        buckets: doc.buckets.map((raw, i) => {
          const { doc: b, id: bucketId, label } = base(raw, i);
          const values = asStringArray(b.values, `${where}.buckets[${i}].values`);
          for (const v of values) {
            if (!options.has(v)) {
              throw new BadRequestException(
                `${where}.buckets[${i}] names an option that question does not offer.`
              );
            }
          }
          return { id: bucketId, label, values };
        }),
      };
    }
    default:
      throw new BadRequestException(
        `${where}.kind must be one of: cotisation, promo, formation, answer.`
      );
  }
}

/**
 * Validates and normalises a whole grid.
 *
 * `assertMatrixValid` then checks what only the assembled document can show: completeness,
 * non-overlapping groups, and the cell count. Kept as two functions because the second is the one a
 * test wants to call with a hand-written matrix, without a form or an association in sight.
 */
export function parsePriceMatrix(raw: unknown, ctx: CriteriaContext): PriceMatrix {
  const doc = asRecord(raw, 'priceMatrix');
  if (!Array.isArray(doc.dimensions)) {
    throw new BadRequestException('priceMatrix.dimensions must be a list.');
  }
  const cells = asRecord(doc.cells, 'priceMatrix.cells');
  const matrix: PriceMatrix = {
    dimensions: doc.dimensions.map((d, i) => parseDimension(d, ctx, i)),
    cells: cells as Record<string, number>,
  };
  assertMatrixValid(matrix);
  return matrix;
}
