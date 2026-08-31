import { BadRequestException } from '@nestjs/common';
import {
  bucketFor,
  findOverlappingBuckets,
  OTHERS_BUCKET_ID,
  type Dimension,
  type PricingFacts,
} from './audience';

/**
 * The price matrix: a form's dimensions and one price per combination.
 *
 * A MATRIX, not an ordered list of rules. That is the whole design and it came from the user, who
 * pointed out that checking the "Filtrer par..." boxes makes a grid that has to be entirely filled
 * - so exactly one cell applies to anybody, and there is no priority rule to define, explain or get
 * wrong. A rule list needs a tie-break; a partition cannot have a tie.
 */
/**
 * One cell: a price in cents, or `null` for a combination that DOES NOT EXIST.
 *
 * `null` is not zero and not a missing cell. It is the manager saying nobody in that situation may
 * answer, which no number can say - 0 means free. Completeness still holds, so exactly one cell
 * still applies to anybody and there is still no priority rule; what changes is that the cell a
 * person lands in may REFUSE them, and `submit` then does.
 */
export type CellValue = number | null;

export interface PriceMatrix {
  /** Ordered. The order decides the cell key and the on-screen layout, never an outcome. */
  dimensions: Dimension[];
  /** Cents or `null`, keyed by `cellKey`. Complete, or the form is refused at save time. */
  cells: Record<string, CellValue>;
}

/**
 * What the grid prices, for the two messages whose wording depends on it.
 *
 * A whole sentence per subject rather than a noun slotted into a template: these strings reach a
 * manager, and a sentence assembled from parts is the kind that ends up reading like a machine.
 */
export type PricedSubject = 'form' | 'product';

const NO_CELL_MESSAGE: Record<PricedSubject, (key: string) => string> = {
  form: (key) =>
    `This form has no price for your situation (cell "${key}"). Its manager must complete the pricing grid.`,
  product: (key) =>
    `This product has no price for your situation (cell "${key}"). Its association must complete the pricing grid.`,
};

const ALL_UNAVAILABLE_MESSAGE: Record<PricedSubject, string> = {
  form: 'Every combination of this grid is marked unavailable, so nobody could answer. Close the form instead.',
  product:
    'Every combination of this grid is marked unavailable, so nobody could buy this. Take the product off sale instead.',
};

/** Whether a key carries a decision - a price, or an explicit "does not exist". */
export function hasCell(cells: Record<string, CellValue>, key: string): boolean {
  return cells[key] === null || typeof cells[key] === 'number';
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
export function cellKeyFor(matrix: PriceMatrix, facts: PricingFacts): string {
  return cellKey(matrix.dimensions.map((d) => bucketFor(d, facts)));
}

/**
 * The price a submitter pays as a base, in cents - or `null` when their cell does not exist.
 *
 * Two different outcomes that must not be confused. `null` is a DECISION the manager made and the
 * caller has to honour by refusing the submission; a MISSING cell is a broken invariant and throws,
 * because the matrix is complete at save time and charging a plausible number instead of saying so
 * is how a wrong price ships quietly. A fallback here is a signal, never a path.
 */
export function resolveCellPrice(
  matrix: PriceMatrix,
  facts: PricingFacts,
  subject: PricedSubject = 'form'
): CellValue {
  const key = cellKeyFor(matrix, facts);
  if (!hasCell(matrix.cells, key)) {
    throw new BadRequestException(NO_CELL_MESSAGE[subject](key));
  }
  return matrix.cells[key];
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
export function assertMatrixValid(
  matrix: PriceMatrix,
  maxCells = 400,
  subject: PricedSubject = 'form'
): void {
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
  const missing = required.filter((k) => !hasCell(cells, k));
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
    // `null` is a decision, checked above by `hasCell` - only a number has to be a valid amount.
    if (value === null) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new BadRequestException(`Price "${key}" must be a whole number of cents, at least 0.`);
    }
  }
  // A grid where every combination is unavailable is a form nobody may answer, or a product
  // nobody may buy. That is a closed thing, not a priced one, and saying so once here beats every
  // person meeting the same refusal one at a time.
  if (required.every((k) => cells[k] === null)) {
    throw new BadRequestException(ALL_UNAVAILABLE_MESSAGE[subject]);
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
  /**
   * The price before any answer dimension is resolved - every one of them at "everyone else".
   * `null` when that combination is unavailable, which the page shows rather than charging.
   */
  baseCents: CellValue;
  /** The buckets that already applied, for display: "Cotisant", "ICM". Empty when none did. */
  appliedLabels: string[];
  /** Still to resolve, in key order. */
  answerDimensions: AnswerDimensionView[];
  /** Price per combination of the answer buckets above, keyed in their order; `null` = unavailable. */
  cells: Record<string, CellValue>;
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
export function pricingViewFor(matrix: PriceMatrix, facts: PricingFacts): PricingView {
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

  const cells: Record<string, CellValue> = {};
  for (const combination of combinations) {
    const full = [...resolved];
    answerDims.forEach(({ index }, i) => {
      full[index] = combination[i];
    });
    const key = cellKey(full as string[]);
    // A cell that is absent rather than null cannot happen - completeness is a save-time invariant
    // - and is reported as unavailable, so a broken grid refuses instead of inventing a price.
    cells[cellKey(combination)] = hasCell(matrix.cells, key) ? matrix.cells[key] : null;
  }

  return {
    baseCents: cells[cellKey(answerDims.map(() => OTHERS_BUCKET_ID))] ?? null,
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
