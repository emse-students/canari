import { answerText, type AnswerWords } from './answerText';
import type { FormItem, Submission } from './api';
import {
  PRODUCT_GRID_AWAITING_CASH_STATUSES,
  PRODUCT_GRID_RECEIVED_STATUSES,
  PRODUCT_GRID_TYPE,
  productGridLinesOf,
  productGridTotals,
  type ProductGrid,
  type ProductGridTotals,
} from './productGridContract';
import { submitterName } from './submissionTable';

/**
 * WHAT THE RESPONSES SCREEN COUNTS, AS PURE FUNCTIONS (WP-G4, owner decisions of 2026-11-06).
 *
 * The screen reads one form's answers - `getSubmissions`, already in the browser - and derives four
 * things from them: the summary cards, the "Réponses" tab's filters and search, the "Totaux" tab's
 * order per grid, and the "Résumé" tab's bars. None of them fetches anything, and none of them
 * holds a rule of its own where a shared one exists: the grid totals are `productGridTotals` over
 * `productGridLinesOf` - the SAME two functions the export's "Totaux" sheet calls
 * (`product-grid-contract.ts`, copied byte for byte) - so the tab and the file cannot disagree.
 */

/** The four views of the "Réponses" tab's filter chips. */
export const RESPONSE_FILTERS = ['all', 'paid', 'unpaid', 'refunded'] as const;
export type ResponseFilter = (typeof RESPONSE_FILTERS)[number];

/**
 * Which filter chip an answer falls under, besides "all". `paid` is money landed; `unpaid` is cash
 * not yet received (`pending_cash`) - the one unpaid state a manager acts on, by marking it paid; an
 * online answer still at Lydia (`pending`) is the payer's to finish and reads under "all" only.
 */
export function filterOf(paymentStatus: string): Exclude<ResponseFilter, 'all'> | null {
  if (paymentStatus === 'paid' || paymentStatus === 'paid_over_capacity') return 'paid';
  if (paymentStatus === 'pending_cash') return 'unpaid';
  if (paymentStatus === 'refunded') return 'refunded';
  return null;
}

/**
 * Whether an answer is a GUEST's - from a public form's link, with no account. An anonymous form's
 * answers have no account either, by design, and are nobody's: never badged.
 */
export function isGuestAnswer(sub: Pick<Submission, 'userId'>, anonymous: boolean): boolean {
  return !anonymous && sub.userId == null;
}

/** The summary cards: counts, and amounts in cents. */
export interface ResponsesSummary {
  answers: number;
  guests: number;
  paid: number;
  unpaidCash: number;
  /** What the cash answers still owe. */
  unpaidCashCents: number;
  /** Money landed and kept: paid answers, and paid over capacity until refunded. */
  collectedCents: number;
  refunded: number;
  refundedCents: number;
}

/** Reads the summary cards off the answers. */
export function responsesSummary(
  subs: readonly Submission[],
  anonymous: boolean
): ResponsesSummary {
  const summary: ResponsesSummary = {
    answers: subs.length,
    guests: 0,
    paid: 0,
    unpaidCash: 0,
    unpaidCashCents: 0,
    collectedCents: 0,
    refunded: 0,
    refundedCents: 0,
  };
  for (const sub of subs) {
    if (isGuestAnswer(sub, anonymous)) summary.guests += 1;
    const filter = filterOf(sub.paymentStatus);
    const cents = sub.totalPaid || 0;
    if (filter === 'paid') {
      summary.paid += 1;
      summary.collectedCents += cents;
    } else if (filter === 'unpaid') {
      summary.unpaidCash += 1;
      summary.unpaidCashCents += cents;
    } else if (filter === 'refunded') {
      summary.refunded += 1;
      summary.refundedCents += cents;
    }
  }
  return summary;
}

/** How many answers each filter chip holds. */
export function filterCounts(subs: readonly Submission[]): Record<ResponseFilter, number> {
  const counts: Record<ResponseFilter, number> = {
    all: subs.length,
    paid: 0,
    unpaid: 0,
    refunded: 0,
  };
  for (const sub of subs) {
    const filter = filterOf(sub.paymentStatus);
    if (filter) counts[filter] += 1;
  }
  return counts;
}

/**
 * The answers a filter and a search keep, in the order given. The search reads what the table
 * shows - the submitter's name (or a guest's reference) and every answer's text - case and accents
 * folded, so "creme" finds "Crème".
 */
export function visibleResponses(
  subs: readonly Submission[],
  items: readonly FormItem[],
  filter: ResponseFilter,
  query: string,
  words: AnswerWords,
  anonymous: boolean
): Submission[] {
  const needle = fold(query.trim());
  return subs.filter((sub) => {
    if (filter !== 'all' && filterOf(sub.paymentStatus) !== filter) return false;
    if (!needle) return true;
    return fold(searchText(sub, items, words, anonymous)).includes(needle);
  });
}

function searchText(
  sub: Submission,
  items: readonly FormItem[],
  words: AnswerWords,
  anonymous: boolean
): string {
  const name = anonymous ? '' : submitterName(sub);
  const answers = items.map((item) => answerText(sub.answers?.[item.id], item, words, sub.lines));
  return [name, sub.reference ?? '', ...answers].join(' ');
}

/** Lower case, accents removed. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** A priced grid question with its definition. */
export type ProductGridQuestion = FormItem & { productGrid: ProductGrid };

/** The form's priced grids, in question order. */
export function productGridQuestions(items: readonly FormItem[]): ProductGridQuestion[] {
  return items.filter(
    (item): item is ProductGridQuestion => item.type === PRODUCT_GRID_TYPE && !!item.productGrid
  );
}

/** One grid's totals, with the question it belongs to. */
export interface GridTotalsView {
  item: ProductGridQuestion;
  totals: ProductGridTotals;
}

/**
 * The "Totaux" tab: every grid's totals over the answers it counts. Paid (and free) answers always,
 * cash not yet received unless `withUnpaid` is off, a refunded answer never - the owner's rule,
 * written once in `PRODUCT_GRID_RECEIVED_STATUSES` / `PRODUCT_GRID_AWAITING_CASH_STATUSES`.
 */
export function gridTotalsViews(
  items: readonly FormItem[],
  subs: readonly Submission[],
  withUnpaid: boolean
): GridTotalsView[] {
  const statuses = withUnpaid
    ? [...PRODUCT_GRID_RECEIVED_STATUSES, ...PRODUCT_GRID_AWAITING_CASH_STATUSES]
    : PRODUCT_GRID_RECEIVED_STATUSES;
  const lines = productGridLinesOf(subs, statuses);
  return productGridQuestions(items).map((item) => ({
    item,
    totals: productGridTotals(item, lines),
  }));
}

/** The question types the "Résumé" tab draws bars for: one bar per option. */
const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice', 'dropdown']);

/**
 * Answers the "Résumé" tab leaves out: settled the other way (refunded), or never completed
 * (cancelled, expired). Each says the person is not in, so their vote is not either.
 */
const NOT_COUNTED_IN_SUMMARY = new Set(['refunded', 'cancelled', 'expired']);

/** One bar: an option, how many answers chose it, and its share of those who answered. */
export interface ChoiceBar {
  label: string;
  count: number;
  /** Of the answers to this question, rounded, 0-100. */
  percent: number;
}

/** One choice question's bars, and how many answers it had. */
export interface ChoiceResult {
  item: FormItem;
  answered: number;
  bars: ChoiceBar[];
}

/**
 * The "Résumé" tab's bars, per choice question. An answer names an option by its id (or, on an
 * older form, by its label); a multiple choice counts once per option ticked, so its bars may add
 * up past 100 %.
 */
export function choiceResults(
  items: readonly FormItem[],
  subs: readonly Submission[]
): ChoiceResult[] {
  const counted = subs.filter((sub) => !NOT_COUNTED_IN_SUMMARY.has(sub.paymentStatus));
  return items
    .filter((item) => CHOICE_TYPES.has(item.type) && (item.options?.length ?? 0) > 0)
    .map((item) => {
      const options = item.options ?? [];
      const counts = options.map(() => 0);
      let answered = 0;
      for (const sub of counted) {
        const raw = sub.answers?.[item.id];
        const values = (Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]).map(
          String
        );
        if (values.length === 0) continue;
        answered += 1;
        options.forEach((option, index) => {
          if (values.includes(option.id ?? option.label) || values.includes(option.label))
            counts[index] += 1;
        });
      }
      return {
        item,
        answered,
        bars: options.map((option, index) => ({
          label: option.label,
          count: counts[index],
          percent: answered ? Math.round((100 * counts[index]) / answered) : 0,
        })),
      };
    });
}
