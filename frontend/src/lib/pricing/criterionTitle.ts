import { m } from '$lib/paraglide/messages';
import type { DimensionKind } from './priceMatrix';

/**
 * A criterion's name as a manager reads it - on its block, in the "Critère" menu and in the corner
 * of the price table ("Promotion \ Formation"). One mapping, so the three never disagree.
 */
export function criterionTitle(kind: DimensionKind): string {
  switch (kind) {
    case 'cotisation':
      return m.form_criterion_cotisation();
    case 'promo':
      return m.form_criterion_promo();
    case 'formation':
      return m.form_criterion_formation();
    case 'answer':
      return m.form_criterion_answer();
  }
}
