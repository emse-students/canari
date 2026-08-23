import { BadRequestException } from '@nestjs/common';
import {
  bucketFor,
  findOverlappingBuckets,
  OTHERS_BUCKET_ID,
  type Dimension,
  type SubmitterFacts,
} from './audience';

/**
 * The price matrix: a form's dimensions and one price per combination.
 *
 * A MATRIX, not an ordered list of rules. That is the whole design and it came from the user, who
 * pointed out that checking the "Filtrer par..." boxes makes a grid that has to be entirely filled
 * - so exactly one cell applies to anybody, and there is no priority rule to define, explain or get
 * wrong. A rule list needs a tie-break; a partition cannot have a tie.
 */
export interface PriceMatrix {
  /** Ordered. The order decides the cell key and the on-screen layout, never an outcome. */
  dimensions: Dimension[];
  /** Cents, keyed by `cellKey`. Complete, or the form is refused at save time. */
  cells: Record<string, number>;
}

/** How many cells a complete matrix has: the product of each dimension's buckets plus its `others`. */
export function expectedCellCount(dimensions: Dimension[]): number {
  return dimensions.reduce((n, d) => n * (d.buckets.length + 1), 1);
}

/** The key of one cell: the bucket id chosen in each dimension, in dimension order. */
export function cellKey(bucketIds: string[]): string {
  return bucketIds.join('|');
}

/** Every cell key a complete matrix must carry, in a stable order. */
export function allCellKeys(dimensions: Dimension[]): string[] {
  return dimensions.reduce<string[]>(
    (keys, d) => {
      const ids = [...d.buckets.map((b) => b.id), OTHERS_BUCKET_ID];
      return keys.flatMap((prefix) => ids.map((id) => (prefix ? `${prefix}|${id}` : id)));
    },
    ['']
  );
}

/** Which cell a submitter falls in. Exactly one, always - `others` in each dimension that misses. */
export function cellKeyFor(matrix: PriceMatrix, facts: SubmitterFacts): string {
  return cellKey(matrix.dimensions.map((d) => bucketFor(d, facts)));
}

/**
 * The price a submitter pays as a base, in cents.
 *
 * Throws rather than falling back to `form.basePrice` when the cell is missing: the matrix is
 * complete by a save-time invariant, so a missing cell means the invariant was bypassed, and
 * charging a plausible number instead of saying so is how a wrong price ships quietly. A fallback
 * here is a signal, never a path.
 */
export function resolveCellPrice(matrix: PriceMatrix, facts: SubmitterFacts): number {
  const key = cellKeyFor(matrix, facts);
  const price = matrix.cells[key];
  if (typeof price !== 'number') {
    throw new BadRequestException(
      `This form has no price for your situation (cell "${key}"). Its manager must complete the pricing grid.`
    );
  }
  return price;
}

/**
 * Validates a matrix as it is saved. Every refusal here is a price somebody would not have had.
 *
 * - a dimension with no bucket is a column of one cell, which is a criterion that discriminates
 *   nothing and a manager who thinks it does;
 * - `others` is generated, so storing a bucket under that id would silently replace it;
 * - duplicate bucket ids collapse two columns into one cell key;
 * - overlapping buckets make the cell depend on bucket ORDER, which is the priority rule this
 *   design exists in order not to have;
 * - a missing or extra cell means the grid is not the grid the dimensions describe.
 */
export function assertMatrixValid(matrix: PriceMatrix, maxCells = 400): void {
  const { dimensions, cells } = matrix;
  if (dimensions.length === 0) {
    throw new BadRequestException('A pricing grid needs at least one criterion.');
  }
  const seenDimensionIds = new Set<string>();
  for (const d of dimensions) {
    if (seenDimensionIds.has(d.id)) {
      throw new BadRequestException(`Duplicate criterion "${d.id}" in the pricing grid.`);
    }
    seenDimensionIds.add(d.id);
    if (d.buckets.length === 0) {
      throw new BadRequestException(
        `Criterion "${d.id}" has no group, so it separates nobody. Remove it or add a group.`
      );
    }
    const ids = new Set<string>();
    for (const b of d.buckets) {
      if (b.id === OTHERS_BUCKET_ID) {
        throw new BadRequestException(
          `"${OTHERS_BUCKET_ID}" is reserved: every criterion already ends with an "everyone else" group.`
        );
      }
      if (ids.has(b.id)) {
        throw new BadRequestException(`Duplicate group "${b.id}" in criterion "${d.id}".`);
      }
      ids.add(b.id);
    }
    const clashes = findOverlappingBuckets(d);
    if (clashes.length > 0) {
      throw new BadRequestException(
        `Groups "${clashes[0][0]}" and "${clashes[0][1]}" of criterion "${d.id}" can both apply to ` +
          'the same person, so the price would depend on their order. Make them exclusive.'
      );
    }
  }

  const expected = expectedCellCount(dimensions);
  if (expected > maxCells) {
    throw new BadRequestException(
      `This grid would have ${expected} prices to fill (limit ${maxCells}). Use fewer groups.`
    );
  }
  const required = allCellKeys(dimensions);
  const missing = required.filter((k) => typeof cells[k] !== 'number');
  if (missing.length > 0) {
    throw new BadRequestException(
      `The pricing grid is incomplete: ${missing.length} price(s) missing, starting with "${missing[0]}".`
    );
  }
  const extra = Object.keys(cells).filter((k) => !required.includes(k));
  if (extra.length > 0) {
    throw new BadRequestException(
      `The pricing grid has ${extra.length} price(s) that match no combination, starting with "${extra[0]}".`
    );
  }
  for (const [key, value] of Object.entries(cells)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new BadRequestException(`Price "${key}" must be a whole number of cents, at least 0.`);
    }
  }
}

/**
 * The question ids a matrix prices on.
 *
 * Their per-option modifiers must NOT be added on top of the cell they selected: the cell already
 * carries the choice, so adding the modifier charges it twice, silently, in the direction that
 * overcharges. Enforced server-side rather than trusted from the editor.
 */
export function pricedQuestionIds(matrix: PriceMatrix | null | undefined): Set<string> {
  return new Set(
    (matrix?.dimensions ?? [])
      .filter((d): d is Extract<Dimension, { kind: 'answer' }> => d.kind === 'answer')
      .map((d) => d.questionId)
  );
}

/** One answer dimension as the fill page needs it: which question, and which options map where. */
export interface AnswerDimensionView {
  id: string;
  questionId: string;
  buckets: { id: string; label: string; values: string[] }[];
}

/**
 * What the fill page is told about pricing: the part of the grid that is still open.
 *
 * The profile dimensions are resolved here, server-side, because they are the ones a client cannot
 * be trusted or even expected to evaluate - it does not know the submitter's cotisation tiers, and
 * `promo`/`formation` come from another service. What remains are the answer dimensions, which the
 * page must resolve live as the person clicks, so it is handed those and the prices they lead to.
 *
 * It learns nothing about what anybody else pays: `cells` is already restricted to this submitter's
 * profile row.
 */
export interface PricingView {
  /** The price before any answer dimension is resolved - every one of them at "everyone else". */
  baseCents: number;
  /** The buckets that already applied, for display: "Cotisant", "ICM". Empty when none did. */
  appliedLabels: string[];
  /** Still to resolve, in key order. */
  answerDimensions: AnswerDimensionView[];
  /** Price per combination of the answer buckets above, keyed in their order. */
  cells: Record<string, number>;
  /**
   * Questions whose per-option modifiers must NOT be added: their answer already selects a cell.
   * Sent so the page shows and totals the same figure the server will charge.
   */
  ignoredModifierQuestionIds: string[];
}

/**
 * Resolves the profile dimensions for one submitter and returns what is left.
 *
 * `others` is included in every answer dimension, exactly as `allCellKeys` does, so "the person has
 * not answered yet" is a priced state rather than a gap - which is what lets the page show a total
 * from the first render.
 */
export function pricingViewFor(matrix: PriceMatrix, facts: SubmitterFacts): PricingView {
  const answerDims: { index: number; dimension: Extract<Dimension, { kind: 'answer' }> }[] = [];
  const resolved: (string | null)[] = matrix.dimensions.map((d, index) => {
    if (d.kind === 'answer') {
      answerDims.push({ index, dimension: d });
      return null;
    }
    return bucketFor(d, facts);
  });

  const appliedLabels: string[] = [];
  matrix.dimensions.forEach((d, i) => {
    if (d.kind === 'answer') return;
    const bucket = d.buckets.find((b) => b.id === resolved[i]);
    if (bucket) appliedLabels.push(bucket.label);
  });

  // Every combination of the remaining dimensions, in the same order they appear in the key.
  const combinations = answerDims.reduce<string[][]>(
    (acc, { dimension }) => {
      const ids = [...dimension.buckets.map((b) => b.id), OTHERS_BUCKET_ID];
      return acc.flatMap((prefix) => ids.map((id) => [...prefix, id]));
    },
    [[]]
  );

  const cells: Record<string, number> = {};
  for (const combination of combinations) {
    const full = [...resolved];
    answerDims.forEach(({ index }, i) => {
      full[index] = combination[i];
    });
    const price = matrix.cells[cellKey(full as string[])];
    if (typeof price === 'number') cells[cellKey(combination)] = price;
  }

  return {
    baseCents: cells[cellKey(answerDims.map(() => OTHERS_BUCKET_ID))] ?? 0,
    appliedLabels,
    answerDimensions: answerDims.map(({ dimension }) => ({
      id: dimension.id,
      questionId: dimension.questionId,
      buckets: dimension.buckets.map((b) => ({ id: b.id, label: b.label, values: b.values })),
    })),
    cells,
    ignoredModifierQuestionIds: [...pricedQuestionIds(matrix)],
  };
}
