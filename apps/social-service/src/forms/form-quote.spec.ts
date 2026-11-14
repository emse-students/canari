import { readFileSync } from 'fs';
import { resolve } from 'path';
import { displaySlices, quoteSubmission, sliceOffersNothing, type QuotedForm } from './form-quote';
import type { CursusView, PricingFacts } from '../pricing/audience';

/**
 * D32's ONE rule, pinned on both sides by one table: `cursusPricingCases.json` beside the fill
 * page's `fillPricing.ts`, which `fillPricing.test.ts` asserts there. Here: the server serves
 * exactly the slices the page is tested on, and charges exactly what the page shows - the cheapest
 * whole total, an unavailable one losing, a tie to the first cursus - with an option closed iff no
 * cursus prices it.
 */
interface PricingCase {
  name: string;
  form: Omit<QuotedForm, 'items'> & {
    items: { id: string; type?: string; options?: { id: string }[] }[];
  };
  cursus: CursusView[];
  answers: Record<string, unknown>;
  slices: unknown[];
  expected: { cents: number | null; cursusIndex: number; closedOptionIds: string[] };
}

const TABLE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../frontend/src/lib/forms/cursusPricingCases.json'),
    'utf8'
  )
) as { cases: PricingCase[] };

/** The facts `submit` builds: a choice answer as a list, a grid's order left to `rawAnswers`. */
function factsFor(c: PricingCase, answers: Record<string, unknown>): PricingFacts {
  const listed: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(answers)) {
    if (typeof value === 'string') listed[id] = [value];
    else if (Array.isArray(value)) listed[id] = value as string[];
  }
  return { cursus: c.cursus, cotisationTiers: [], answers: listed };
}

function charged(c: PricingCase, answers: Record<string, unknown>) {
  const visible = new Set(c.form.items.map((item) => item.id));
  const choice = quoteSubmission(c.form, factsFor(c, answers), visible, answers);
  const cents =
    choice.cents === null ? null : (choice.quote.baseCents as number) + choice.quote.gridCents;
  return { cents, index: choice.index };
}

describe('D32 - the server against the shared table of cursus pricing cases', () => {
  it('the table is not empty', () => {
    expect(TABLE.cases.length).toBeGreaterThan(0);
  });

  describe.each(TABLE.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    it('serves exactly the slices the page is tested on', () => {
      expect(displaySlices(c.form, factsFor(c, {}))).toEqual(c.slices);
    });

    it('charges the expected total, through the expected cursus', () => {
      const { cents, index } = charged(c, c.answers);
      expect(cents).toBe(c.expected.cents);
      // The table counts SLICES (duplicates folded): the winning cursus's own slice is the one named.
      const own = displaySlices(c.form, { ...factsFor(c, {}), cursus: [c.cursus[index]] });
      expect(own).toEqual([c.slices[c.expected.cursusIndex]]);
    });

    it('closes an option exactly when no cursus prices it', () => {
      const closed: string[] = [];
      const dimensions = c.form.priceMatrix?.dimensions ?? [];
      for (const dimension of dimensions) {
        if (dimension.kind !== 'answer') continue;
        const item = c.form.items.find((i) => i.id === dimension.questionId);
        for (const option of item?.options ?? []) {
          const answers = { ...c.answers, [dimension.questionId]: option.id };
          if (charged(c, answers).cents === null) closed.push(option.id);
        }
      }
      expect(closed).toEqual(c.expected.closedOptionIds);
    });
  });

  it('a slice offers nothing only when its whole row is unavailable', () => {
    const [allClosed] = TABLE.cases.filter((c) => c.expected.cents === null);
    const slices = displaySlices(allClosed.form, factsFor(allClosed, {}));
    expect(slices.some(sliceOffersNothing)).toBe(false);
  });
});
