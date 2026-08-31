import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import { priceRange, type PriceMatrix } from '$lib/pricing/priceMatrix';

/**
 * The one line the save bar shows: how many questions, and what the form costs.
 *
 * Shared because the two screens had drifted: the create page printed the price and the edit page
 * printed only the question count, so the same form summarised itself two ways depending on which
 * door you came in by. Neither behaviour was chosen - one page simply gained the price and the other
 * did not.
 */
export interface FormSummaryInput {
  questionCount: number;
  requiresPayment: boolean;
  /** The single price in euros; meaningless when a grid is on. */
  basePrice: number;
  /** The grid, when the form is priced by one. */
  priceMatrix: PriceMatrix | null;
}

/** Euros, in the reader's locale, with no trailing zeros to read past. */
function euros(value: number): string {
  return value.toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/**
 * The price half of the summary, or null when there is nothing worth saying.
 *
 * A grid gets a RANGE rather than one number, because it has no single price - and a range is what
 * the fill page shows the submitter too ("a partir de"). A grid with every cell unavailable has no
 * range at all; the save is blocked for that anyway, so the line stays silent rather than inventing
 * a zero.
 */
function priceLabel(input: FormSummaryInput): string | null {
  if (!input.requiresPayment) return m.form_free_label();
  if (input.priceMatrix) {
    const range = priceRange(input.priceMatrix);
    if (!range) return null;
    return range.min === range.max
      ? `${euros(range.max)} €`
      : `${euros(range.min)} - ${euros(range.max)} €`;
  }
  return input.basePrice > 0 ? `${euros(input.basePrice)} €` : null;
}

export function formSummary(input: FormSummaryInput): string {
  const questions =
    input.questionCount === 1
      ? m.form_questions_count_one()
      : m.form_questions_count({ count: input.questionCount });
  const price = priceLabel(input);
  return price ? `${questions} · ${price}` : questions;
}
