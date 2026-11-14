import { cursusViews, type CursusFacts, type CursusView, type PricingFacts } from './audience';

/**
 * A SPEC'S FACTS, BY HAND: `promo`/`formation` build ONE cursus (what every spec wrote before D32),
 * `cursus` gives several. Shared so the specs of pricing, forms and products build facts one way.
 */
export type FactsOver = Partial<Omit<PricingFacts, 'cursus'>> &
  Partial<CursusView> & { cursus?: readonly CursusView[] };

/** A person's facts. */
export function factsOf({
  promo = null,
  formation = null,
  cursus,
  ...rest
}: FactsOver = {}): PricingFacts {
  return { cursus: cursus ?? [{ promo, formation }], cotisationTiers: [], answers: {}, ...rest };
}

/** The facts through their FIRST cursus - what a bucket or a cell is read from in a unit spec. */
export function viewOf(over: FactsOver = {}): CursusFacts {
  return cursusViews(factsOf(over))[0];
}
