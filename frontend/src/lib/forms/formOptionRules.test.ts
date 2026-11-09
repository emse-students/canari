import { describe, expect, it } from 'vitest';
import {
  FORM_OPTION_CONFLICTS,
  FORM_PUBLIC_GUEST_TIER_UNAVAILABLE,
  OTHERS_BUCKET_ID,
  conditionNamesProfile,
  conflictsIfEnabled,
  formConfigConflicts,
  formOptionConflicts,
  guestTierUnavailable,
  isGuestCell,
  type FormOption,
  type FormOptionConflict,
  type FormOptionState,
} from './formOptionRules';

/**
 * THE ONE RULE ON WHICH FORM OPTIONS EXCLUDE EACH OTHER. This file is the spec of BOTH copies:
 * social-service's `form-option-rules.ts` is the same bytes, held so by
 * `.github/scripts/tests/declared-duplicates.test.mjs`, so what is proven here is what the server
 * refuses.
 */
const OFF: FormOptionState = {
  anonymous: false,
  isPublic: false,
  takesPayment: false,
  grantsCotisation: false,
  restrictsAudience: false,
  hasFileQuestion: false,
};
const OPTIONS = Object.keys(OFF) as FormOption[];

/**
 * The decision, written out by hand rather than read back from the table: which pairs exclude each
 * other, as the owner set it on 2026-11-06. Public with a price grid on who the person is is NOT
 * here - a guest pays the "everyone else" tier - and public with a payment never was.
 */
const EXPECTED: Record<string, FormOptionConflict> = {
  'anonymous+takesPayment': 'FORM_ANONYMOUS_PAYMENT',
  'anonymous+grantsCotisation': 'FORM_ANONYMOUS_COTISATION_GRANT',
  'anonymous+hasFileQuestion': 'FORM_ANONYMOUS_FILE',
  'isPublic+restrictsAudience': 'FORM_PUBLIC_AUDIENCE',
  'isPublic+grantsCotisation': 'FORM_PUBLIC_COTISATION_GRANT',
  'isPublic+hasFileQuestion': 'FORM_PUBLIC_FILE',
};

/** The expected code of a pair, in either order - or undefined when the two may coexist. */
function expectedFor(a: FormOption, b: FormOption): FormOptionConflict | undefined {
  return EXPECTED[`${a}+${b}`] ?? EXPECTED[`${b}+${a}`];
}

describe('formOptionConflicts', () => {
  it('finds nothing on a form with every option off, or with any single one on', () => {
    expect(formOptionConflicts(OFF)).toEqual([]);
    for (const option of OPTIONS) {
      expect(formOptionConflicts({ ...OFF, [option]: true })).toEqual([]);
    }
  });

  it('holds exactly the decided pairs, no more', () => {
    const table = Object.fromEntries(
      Object.entries(FORM_OPTION_CONFLICTS).map(([code, [a, b]]) => [`${a}+${b}`, code])
    );
    expect(table).toEqual(EXPECTED);
  });

  // Every pair of options, both on: a conflict exactly when the decision says so.
  for (const [i, a] of OPTIONS.entries()) {
    for (const b of OPTIONS.slice(i + 1)) {
      const code = expectedFor(a, b);
      it(`${a} with ${b}: ${code ?? 'allowed'}`, () => {
        expect(formOptionConflicts({ ...OFF, [a]: true, [b]: true })).toEqual(code ? [code] : []);
      });
    }
  }
});

describe('conflictsIfEnabled - the order of the clicks cannot matter', () => {
  // Every ORDERED pair: switch `first` on, then ask whether `second` may follow. The answer must be
  // the pair's code whichever of the two came first - the asymmetry the owner met on 2026-11-06
  // ("public" shut by a grid, but a grid accepted after "public") is this test failing.
  for (const first of OPTIONS) {
    for (const second of OPTIONS) {
      if (first === second) continue;
      const code = expectedFor(first, second);
      it(`${first} on, then ${second}: ${code ?? 'offered'}`, () => {
        expect(conflictsIfEnabled({ ...OFF, [first]: true }, second)).toEqual(code ? [code] : []);
      });
    }
  }

  it('names every reason a switch is shut, and only the real ones', () => {
    const state = { ...OFF, grantsCotisation: true, hasFileQuestion: true, takesPayment: true };
    expect(conflictsIfEnabled(state, 'isPublic')).toEqual([
      'FORM_PUBLIC_COTISATION_GRANT',
      'FORM_PUBLIC_FILE',
    ]);
  });

  it('never shuts a switch that is already on: the way out stays open', () => {
    const incoherent = { ...OFF, isPublic: true, grantsCotisation: true };
    expect(conflictsIfEnabled(incoherent, 'isPublic')).toEqual([]);
    expect(conflictsIfEnabled(incoherent, 'grantsCotisation')).toEqual([]);
  });

  it('reports only the pairs of the option asked about', () => {
    const state = { ...OFF, anonymous: true, isPublic: true, takesPayment: true };
    expect(conflictsIfEnabled(state, 'hasFileQuestion')).toEqual([
      'FORM_ANONYMOUS_FILE',
      'FORM_PUBLIC_FILE',
    ]);
  });
});

describe('conditionNamesProfile', () => {
  it('is true for a promo, a formation or a cotisation held or not', () => {
    expect(conditionNamesProfile({ promo: { values: [2026] } })).toBe(true);
    expect(conditionNamesProfile({ formation: { values: ['ICM'] } })).toBe(true);
    expect(conditionNamesProfile({ cotisation: { anyTier: true } })).toBe(true);
    expect(conditionNamesProfile({ notCotisation: { anyTier: true } })).toBe(true);
  });

  it('is false for an answer alone, an absent condition, or an absent key', () => {
    expect(conditionNamesProfile({ answer: { questionId: 'q', optionIds: ['a'] } })).toBe(false);
    expect(conditionNamesProfile(null)).toBe(false);
    expect(conditionNamesProfile(undefined)).toBe(false);
    expect(conditionNamesProfile({ promo: undefined })).toBe(false);
  });
});

describe('the tier a guest pays', () => {
  const O = OTHERS_BUCKET_ID;
  /** Promo (1A or others) by an answer (menu or others), every cell priced. */
  const grid = (cells: Record<string, number | null>) => ({
    dimensions: [{ kind: 'promo' }, { kind: 'answer' }],
    cells,
  });

  it('is the "everyone else" group of every criterion on who the person is', () => {
    const g = grid({});
    expect(isGuestCell(g, `${O}|menu`)).toBe(true);
    expect(isGuestCell(g, `${O}|${O}`)).toBe(true);
    expect(isGuestCell(g, `b1|${O}`)).toBe(false);
    expect(isGuestCell(g, 'b1|menu')).toBe(false);
  });

  it('is unavailable only when every guest cell is', () => {
    expect(
      guestTierUnavailable(
        grid({ 'b1|menu': 5, [`b1|${O}`]: 5, [`${O}|menu`]: null, [`${O}|${O}`]: null })
      )
    ).toBe(true);
    expect(
      guestTierUnavailable(
        grid({ 'b1|menu': 5, [`b1|${O}`]: 5, [`${O}|menu`]: 8, [`${O}|${O}`]: null })
      )
    ).toBe(false);
    expect(guestTierUnavailable(null)).toBe(false);
  });

  it('is judged on a public form only, after the pairs', () => {
    const closed = grid({ 'b1|menu': 5, [`b1|${O}`]: 5, [`${O}|menu`]: null, [`${O}|${O}`]: null });
    expect(formConfigConflicts({ ...OFF, takesPayment: true }, closed)).toEqual([]);
    expect(
      formConfigConflicts(
        { ...OFF, isPublic: true, takesPayment: true, grantsCotisation: true },
        closed
      )
    ).toEqual(['FORM_PUBLIC_COTISATION_GRANT', FORM_PUBLIC_GUEST_TIER_UNAVAILABLE]);
  });
});
