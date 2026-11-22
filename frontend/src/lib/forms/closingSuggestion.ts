import { formatLocalDateTime, fromDate } from '$lib/components/ui/dateTimeField';
import { formChargesMoney, type PublishPaymentShape } from './publish';

/**
 * THE CLOSING DATE SUGGESTED AT PUBLICATION (owner, 2026-11-21; docs/wiki/frontend/modules/forms.md,
 * "The question put to a form left open"). 17 of the 21 forms on production had no closing date and
 * nine of them had been silent for a fortnight or more, so the publish step OFFERS one - never forces
 * it: one tap keeps the form open, as it always was.
 *
 * THE DEFAULT COMES FROM THE FORM'S NATURE, read off production on 2026-11-21 (the span from a
 * form's first to its last answer, and the end the managers who set one chose):
 * - **quick** - a capped form (places that fill) or an anonymous one (a poll): the 7 forms of this
 *   kind got every answer within 3 days, one of 123 answers in a single day. **7 days.**
 * - **charges money** - an order or a paid registration: payments settle after the answer (cash,
 *   the hold of an online payment), and the two paid forms stayed alive 8 and 56 days. **21 days**,
 *   the window after which the form is asked about anyway (`STALE_OPEN_FORM_DAYS` on the server).
 * - **everything else** - a free form or questionnaire: 8 forms, answered over 1 to 16 days (median
 *   5), and the four managers who set an end chose 7 to 11 days. **14 days.**
 * The count starts from the opening when it is still to come (a form that opens in March is not
 * suggested a closing in February), else from now, and ends at 23:59 of that day.
 */
export const CLOSING_SUGGESTION_DAYS = { quick: 7, standard: 14, paid: 21 } as const;

/** Which of the three natures a form has. */
export type ClosingSuggestionKind = keyof typeof CLOSING_SUGGESTION_DAYS;

/** What {@link suggestClosingDate} reads of a form (the editor's state or a payload). */
export interface ClosingSuggestionShape extends PublishPaymentShape {
  maxSubmissions?: number | null;
  anonymous?: boolean | null;
}

/** The suggestion: how many days, why, and the `datetime-local` value the closing field takes. */
export interface ClosingSuggestion {
  kind: ClosingSuggestionKind;
  days: number;
  /** `YYYY-MM-DDTHH:mm`, wall time in the viewer's zone - the closing field's own format. */
  value: string;
}

/** The nature of a form for the purpose of {@link suggestClosingDate}: a price outranks the rest. */
export function closingSuggestionKind(form: ClosingSuggestionShape): ClosingSuggestionKind {
  if (formChargesMoney(form)) return 'paid';
  if (form.anonymous === true || (form.maxSubmissions ?? 0) > 0) return 'quick';
  return 'standard';
}

/**
 * The closing date offered for a form with none, or `null` when it has one already.
 *
 * @param opensAt The editor's opening (`datetime-local`, `''` for none): a closing is counted from it
 *   while it is still to come, so the suggestion is always after the opening.
 * @param now Injected: the caller's clock, never read here (a test never asserts a wall clock).
 */
export function suggestClosingDate(
  form: ClosingSuggestionShape,
  state: { opensAt: string; closedAt: string },
  now: Date
): ClosingSuggestion | null {
  if (state.closedAt) return null;
  const kind = closingSuggestionKind(form);
  const days = CLOSING_SUGGESTION_DAYS[kind];
  const opens = state.opensAt ? new Date(state.opensAt) : null;
  const from = opens && !Number.isNaN(opens.getTime()) && opens > now ? opens : now;
  const end = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, 23, 59);
  return { kind, days, value: formatLocalDateTime(fromDate(end)) };
}
