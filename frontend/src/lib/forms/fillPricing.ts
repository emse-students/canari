import { OTHERS_BUCKET_ID, cellKey, hasCell, type CellValue } from '$lib/pricing/priceMatrix';
import type { AnswerDimensionView, FormItem, PricingView } from './api';
import { pricedQuestionsAwaitingAnswer, type Selections } from './fillAnswers';

/**
 * WHAT A FILL PAGE SHOWS ABOUT THE PRICE, FROM THE SLICE THE SERVER SENT - one function for both fill
 * pages: the member's (`/forms/:id`) and the guest's (`/f/:id`, WP-P1 of the paid public forms
 * chantier). It was the member page's own code until a second page needed the same total; two
 * copies of a price rule is how a page and the invoice come to disagree.
 *
 * The page derives no pricing RULE: everything about who the person is was resolved by the server
 * (a guest's slice is the whole grid, since a public form prices on answers only), and what is left
 * is their own answers, resolved here as they click. The server recomputes the whole thing at submit
 * and that figure is what is charged.
 */
export interface FillPriceState {
  /** The base price their answers land on; `null` for a combination that does not exist. */
  baseCents: CellValue;
  /** Whether every priced question is answered, so a cell is chosen. */
  priceDecided: boolean;
  /** The combination they landed on does not exist: nothing to pay, nothing to submit. */
  priceUnavailable: boolean;
  /** The base price once known to exist; zero for a free form, so the display stays arithmetic. */
  priceCents: number;
  /** Options that would land them on a combination marked as not existing. */
  unavailableOptionIds: Set<string>;
  /** Questions the grid prices on: their options add no supplement. */
  pricedByGrid: Set<string>;
  /** Base plus supplements, what the pay button names; 0 while undecided or unavailable. */
  total: number;
  /** Why this price - " (Cotisant, ICM)" from the groups the server matched - or ''. */
  appliedLabel: string;
}

/** Which group of one answer criterion an answer falls in - `others` when it matches none. */
export function bucketIdOf(dimension: AnswerDimensionView, answer: unknown): string {
  const chosen = Array.isArray(answer) ? (answer as string[]) : answer ? [String(answer)] : [];
  return (
    dimension.buckets.find((b) => chosen.some((v) => b.values.includes(v)))?.id ?? OTHERS_BUCKET_ID
  );
}

/**
 * One cell of the slice: a price, or `null` for a combination that does not exist.
 *
 * A key the slice does not carry is not a cheaper price - it is a broken invariant, since the
 * server sends every combination and completeness is enforced when the grid is saved. So it is
 * logged and reported as unavailable rather than falling back to a figure nobody chose.
 */
export function cellOf(view: PricingView, bucketIdsInOrder: string[]): CellValue {
  const key = cellKey(bucketIdsInOrder);
  if (!hasCell(view.cells, key)) {
    console.error(`[FORMS] pricing slice carries no cell "${key}" - treated as unavailable`);
    return null;
  }
  return view.cells[key];
}

/** The supplement an option adds, in cents: zero for a question the grid prices on. */
export function optionModifierOf(
  state: Pick<FillPriceState, 'pricedByGrid'>,
  item: { id: string },
  option: { priceModifier: number }
): number {
  return state.pricedByGrid.has(item.id) ? 0 : option.priceModifier;
}

/** Everything a fill page shows about the price, for the answers given so far. */
export function fillPriceState(input: {
  basePrice: number;
  pricing: PricingView | null;
  items: FormItem[];
  visibleItems: FormItem[];
  selections: Selections;
}): FillPriceState {
  const { basePrice, pricing, items, visibleItems, selections } = input;

  // With a grid, the cell the answers land in - looked up in the slice, never computed from a
  // rule here. Without one, the form's single price.
  const baseCents: CellValue = !pricing
    ? basePrice
    : cellOf(
        pricing,
        pricing.answerDimensions.map((d) => bucketIdOf(d, selections[d.questionId]))
      );

  // The priced questions still to be answered: until they are, no cell is chosen, so the page says
  // nothing about the price. The "others" cell they would fall in is not their price.
  const awaiting = pricing
    ? pricedQuestionsAwaitingAnswer(
        visibleItems,
        pricing.answerDimensions.map((d) => d.questionId),
        selections
      )
    : new Set<string>();
  const priceDecided = awaiting.size === 0;
  const priceUnavailable = priceDecided && baseCents === null;

  // Computed rather than hidden: an option removed without a word reads as a bug. Only the
  // questions the grid prices on can do this - every other answer leaves the cell where it was.
  const unavailableOptionIds = new Set<string>();
  if (pricing) {
    const current = pricing.answerDimensions.map((d) => bucketIdOf(d, selections[d.questionId]));
    pricing.answerDimensions.forEach((dimension, index) => {
      // Another priced question not answered yet leaves this one's cell undecided: nothing is
      // closed until it is (an "others" stand-in would close options the person can reach).
      const othersPending = pricing.answerDimensions.some(
        (other, j) => j !== index && awaiting.has(other.questionId)
      );
      if (othersPending) return;
      const item = items.find((i) => i.id === dimension.questionId);
      for (const option of item?.options ?? []) {
        if (!option.id) continue;
        const candidate = [...current];
        candidate[index] = bucketIdOf(dimension, option.id);
        if (cellOf(pricing, candidate) === null) unavailableOptionIds.add(option.id);
      }
    });
  }

  // A question the grid prices on adds no supplement: its answer already chose the cell.
  const pricedByGrid = new Set(pricing?.ignoredModifierQuestionIds ?? []);

  // Nothing to total on an unavailable combination (zero would read as free on a form that is
  // going to refuse), nor before the cell is chosen.
  let total = 0;
  if (priceDecided && baseCents !== null) {
    total = baseCents;
    for (const item of visibleItems) {
      const val = selections[item.id];
      if (!val || pricedByGrid.has(item.id)) continue;
      if (['single_choice', 'dropdown'].includes(item.type)) {
        const opt = item.options?.find((o) => o.id === val);
        if (opt) total += opt.priceModifier;
      } else if (item.type === 'multiple_choice' && Array.isArray(val)) {
        for (const id of val) {
          const opt = item.options?.find((o) => o.id === id);
          if (opt) total += opt.priceModifier;
        }
      }
    }
    total = Math.max(0, total);
  }

  return {
    baseCents,
    priceDecided,
    priceUnavailable,
    priceCents: baseCents ?? 0,
    unavailableOptionIds,
    pricedByGrid,
    total,
    appliedLabel: pricing?.appliedLabels.length ? ` (${pricing.appliedLabels.join(', ')})` : '',
  };
}
