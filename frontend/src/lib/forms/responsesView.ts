import { answerText, commentText, otherText, type AnswerWords } from './answerText';
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
 * The screen reads one form's answers - `getSubmissions`, already in the browser - and derives three
 * things from them: the summary cards, the "Réponses" tab's filters and search, and the "Totaux"
 * tab's order per grid. (The "Résumé" tab is NOT derived here: the server aggregates it,
 * `resultsView.ts`.) None of them fetches anything, and none of them holds a rule of its own where a shared one exists: the grid totals are `productGridTotals` over
 * `productGridLinesOf` - the SAME two functions the export's "Totaux" sheet calls
 * (`product-grid-contract.ts`, copied byte for byte) - so the tab and the file cannot disagree.
 */

/** The five views of the "Réponses" tab's filter chips. */
export const RESPONSE_FILTERS = ['all', 'paid', 'unpaid', 'abandoned', 'refunded'] as const;
export type ResponseFilter = (typeof RESPONSE_FILTERS)[number];

/**
 * Whether an online answer was ABANDONED: its payment was cancelled or expired, or it is still
 * `pending` but past its hold - the server says so (`holdsSeat`, the predicate the capacity count
 * uses), the 30-minute rule is never re-implemented here. An older server sends no `holdsSeat`:
 * a `pending` row then stays counted, as before.
 */
export function isAbandoned(sub: Pick<Submission, 'paymentStatus' | 'holdsSeat'>): boolean {
  if (sub.paymentStatus === 'cancelled' || sub.paymentStatus === 'expired') return true;
  return sub.paymentStatus === 'pending' && sub.holdsSeat === false;
}

/**
 * Which filter chip an answer falls under, besides "all". `paid` is money landed; `unpaid` is cash
 * not yet received (`pending_cash`) - the one unpaid state a manager acts on, by marking it paid;
 * `abandoned` is an online payment that never landed (`isAbandoned`); `refunded` has its own chip.
 * An online answer still within its hold is the payer's to finish and reads under "all" only.
 */
export function filterOf(
  sub: Pick<Submission, 'paymentStatus' | 'holdsSeat'>
): Exclude<ResponseFilter, 'all'> | null {
  const status = sub.paymentStatus;
  if (status === 'paid' || status === 'paid_over_capacity') return 'paid';
  if (status === 'pending_cash') return 'unpaid';
  if (status === 'refunded') return 'refunded';
  if (isAbandoned(sub)) return 'abandoned';
  return null;
}

/**
 * Whether "Toutes" lists an answer: the ones that COUNT. An abandoned payment holds no seat and a
 * refunded one gave its seat back (the server's `seatHoldingWhere` excludes both), so each reads
 * under its own chip. `paid_over_capacity` stays: the money landed, the organiser owes a refund,
 * and hiding that row would hide the one thing to act on.
 */
export function isCounted(sub: Pick<Submission, 'paymentStatus' | 'holdsSeat'>): boolean {
  const filter = filterOf(sub);
  return filter !== 'abandoned' && filter !== 'refunded';
}

/**
 * The seats taken, for the "47 / 50 places" counter: the answers the server says hold one, plus the
 * anonymous answers still waiting for their batch (`held`, not in the list yet). The same notion
 * as the server's `submissionCount`, summed from the same predicate.
 */
export function seatsTaken(subs: readonly Pick<Submission, 'holdsSeat'>[], held = 0): number {
  return subs.filter((sub) => sub.holdsSeat === true).length + held;
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
  /**
   * Money landed and kept: paid answers, and paid over capacity until refunded, LESS what a partial
   * refund already gave back on them - when `partialRefundedCents` could tell.
   */
  collectedCents: number;
  /** Answers refunded in full (status `refunded`). */
  refunded: number;
  /** Everything that went back: the full refunds, and the partial ones `partialRefundedCents` knew. */
  refundedCents: number;
}

/**
 * Reads the summary cards off the answers. A PARTIAL refund leaves its answer `paid` with its
 * `totalPaid` whole - only a refund of the whole payment moves it to `refunded` - so the amount it
 * gave back is read from the payment's refund standing (`partialRefundedCents`, by answer) and
 * moved from collected to refunded. Without it (a manager who may not read refunds) the collected
 * amount is gross of partial refunds, and the card says so.
 */
export function responsesSummary(
  subs: readonly Submission[],
  anonymous: boolean,
  partialRefundedCents: (sub: Submission) => number = () => 0
): ResponsesSummary {
  const summary: ResponsesSummary = {
    answers: 0,
    guests: 0,
    paid: 0,
    unpaidCash: 0,
    unpaidCashCents: 0,
    collectedCents: 0,
    refunded: 0,
    refundedCents: 0,
  };
  for (const sub of subs) {
    if (isCounted(sub)) {
      summary.answers += 1;
      if (isGuestAnswer(sub, anonymous)) summary.guests += 1;
    }
    const filter = filterOf(sub);
    const cents = sub.totalPaid || 0;
    if (filter === 'paid') {
      // Never more than the answer paid: a standing cannot give back what was not received.
      const back = Math.min(Math.max(partialRefundedCents(sub), 0), cents);
      summary.paid += 1;
      summary.collectedCents += cents - back;
      summary.refundedCents += back;
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
    all: 0,
    paid: 0,
    unpaid: 0,
    abandoned: 0,
    refunded: 0,
  };
  for (const sub of subs) {
    if (isCounted(sub)) counts.all += 1;
    const filter = filterOf(sub);
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
    if (filter === 'all' ? !isCounted(sub) : filterOf(sub) !== filter) return false;
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
  const answers = items.flatMap((item) => [
    answerText(sub.answers?.[item.id], item, words, sub.lines, otherText(sub.answers, item.id)),
    commentText(sub.answers, item.id),
  ]);
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
