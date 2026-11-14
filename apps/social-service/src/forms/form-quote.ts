import { cheapestCursus, type CursusChoice, type PricingFacts } from '../pricing/audience';
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
 * and the cheapest total wins (`cheapestCursus`). Two operations price a form, and each picks its
 * winner HERE, once, so no caller re-derives a bucket from another cursus than the one priced:
 *
 * - `quoteSubmission`, at submit: the base cell for the visible answers plus every priced grid's
 *   lines for the order actually sent. Option supplements are left out of the comparison - they do
 *   not depend on who the person is, so they add the same amount to every total.
 * - `quoteDisplay`, for the page (`/check`, the public read): there is no order yet, so it compares
 *   a REFERENCE total - the cheapest combination the person's grid row still offers, plus one unit
 *   at every price of every priced grid - and hands the page the winner's slice and grid prices.
 *
 * The two can name different cursus only when two cursus each win on part of the form (one cheaper
 * on a grid's tier, the other on the base cell): the page then totals with the displayed cursus,
 * and submit charges the cheapest, which is never MORE than the page showed.
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

/** What the page is told of the price, for the cursus that won the reference total. */
export interface DisplayQuote {
  pricing: PricingView | null;
  productGridPrices: ProductGridPrices;
}

/**
 * The cheapest cursus for the page, before any answer: its grid slice and its grid prices, so the
 * buckets and tiers shown are the ones of ONE cursus. A cursus whose grid row is entirely
 * unavailable loses to any other, so the page reports "not open to you" only when every cursus is.
 */
export function quoteDisplay(form: QuotedForm, facts: PricingFacts): CursusChoice<DisplayQuote> {
  return cheapestCursus(
    facts,
    (view) => ({
      pricing: form.priceMatrix ? pricingViewFor(form.priceMatrix, view) : null,
      productGridPrices: productGridPricesFor(form.items, view),
    }),
    (quote) => {
      const offered = quote.pricing
        ? Object.values(quote.pricing.cells).filter((cell): cell is number => cell !== null)
        : [form.basePrice];
      if (offered.length === 0) return null;
      const basket = Object.values(quote.productGridPrices).reduce(
        (sum, viewer) => sum + Object.values(viewer.prices).reduce((a, b) => a + b, 0),
        0
      );
      return Math.min(...offered) + basket;
    }
  );
}
