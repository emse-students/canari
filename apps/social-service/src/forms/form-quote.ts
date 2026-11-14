import {
  cheapestCursus,
  cursusViews,
  type CursusChoice,
  type PricingFacts,
} from '../pricing/audience';
import {
  pricingViewFor,
  resolveCellPrice,
  type CellValue,
  type PriceMatrix,
  type PricingView,
} from '../pricing/price-matrix';
import { productGridItems, productGridPricesFor, viewerPricesFor } from './product-grid';
import {
  parseProductGridAnswer,
  productGridLines,
  productGridTotalCents,
  type ProductGridAnswer,
  type ProductGridPrices,
} from './product-grid-contract';

/**
 * WHAT A FORM CHARGES A PERSON WITH SEVERAL CURSUS (D32): the form is priced WHOLE once per cursus
 * and the cheapest total wins (`cheapestCursus`: an unavailable total loses, a tie goes to the first
 * cursus). Two operations read it, through ONE rule:
 *
 * - `quoteSubmission`, at submit: the base cell for the visible answers plus every priced grid's
 *   lines for the order actually sent. Option supplements are left out of the comparison - they do
 *   not depend on who the person is, so they add the same amount to every total.
 * - `displaySlices`, for the page (`/check`, the public read): there is no order yet, so the page is
 *   handed EVERY distinct cursus's slice and totals each for the answers as they are typed, with the
 *   same rule (`frontend/src/lib/forms/fillPricing.ts`). It reveals nothing beyond the viewer's own
 *   cursus. The two sides are pinned to one table of cases (`cursusPricingCases.json`, asserted by
 *   `form-quote.spec.ts` here and `fillPricing.test.ts` there).
 */

/** The form fields a quote reads. */
export interface QuotedForm {
  basePrice: number;
  priceMatrix: PriceMatrix | null;
  items: readonly { id: string; type?: string }[] | null;
}

/** One cursus's price for a submission. */
export interface SubmissionQuote {
  /** The base cell for the visible answers (or the form's single price); null = unavailable. */
  baseCents: CellValue;
  /** The priced grids' lines for the order sent, at this cursus's tier. */
  gridCents: number;
}

/**
 * The cheapest cursus for one submission. `facts.answers` must be the VISIBLE answers (what decides
 * the cell); `rawAnswers` carries the grids' orders as sent. A grid whose answer does not parse is
 * left out here - the submit refuses it, coded, with the same parser.
 */
export function quoteSubmission(
  form: QuotedForm,
  facts: PricingFacts,
  visible: ReadonlySet<string>,
  rawAnswers: Record<string, unknown>
): CursusChoice<SubmissionQuote> {
  return cheapestCursus(
    facts,
    (view) => {
      const baseCents = form.priceMatrix
        ? resolveCellPrice(form.priceMatrix, view)
        : form.basePrice;
      let gridCents = 0;
      for (const item of productGridItems(form.items)) {
        if (!visible.has(item.id)) continue;
        const parsed = parseProductGridAnswer(item.productGrid, rawAnswers[item.id]);
        // Narrowed by hand: this package compiles without strictNullChecks.
        if (!parsed.ok) continue;
        const { answer, units } = parsed as { answer: ProductGridAnswer; units: number };
        if (units === 0) continue;
        gridCents += productGridTotalCents(
          productGridLines(item, answer, viewerPricesFor(item, view))
        );
      }
      return { baseCents, gridCents };
    },
    (quote) => (quote.baseCents === null ? null : quote.baseCents + quote.gridCents)
  );
}

/** What the page is told of the price through ONE cursus: its grid row and its grid prices. */
export interface CursusSlice {
  pricing: PricingView | null;
  productGridPrices: ProductGridPrices;
}

/**
 * Every DISTINCT slice the person's cursus give, in cursus order (the first cursus's first): two
 * cursus landing on the same row and the same tiers are one slice, so the page totals no copy. The
 * page closes an option, or reports "not open to you", only when EVERY slice does.
 */
export function displaySlices(form: QuotedForm, facts: PricingFacts): CursusSlice[] {
  const slices: CursusSlice[] = [];
  const seen = new Set<string>();
  for (const view of cursusViews(facts)) {
    const slice: CursusSlice = {
      pricing: form.priceMatrix ? pricingViewFor(form.priceMatrix, view) : null,
      productGridPrices: productGridPricesFor(form.items, view),
    };
    // Built by the same code from the same form, so equal slices serialise identically.
    const key = JSON.stringify(slice);
    if (seen.has(key)) continue;
    seen.add(key);
    slices.push(slice);
  }
  return slices;
}

/** Whether a slice's grid row is entirely unavailable: nothing this cursus could answer. */
export function sliceOffersNothing(slice: CursusSlice): boolean {
  return !!slice.pricing && Object.values(slice.pricing.cells).every((cell) => cell === null);
}
