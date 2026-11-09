import { describe, it, expect, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SocialApiError } from '$lib/associations/api';
import {
  firstEmptyConditionQuestion,
  firstItemsFaultQuestion,
  refusedProductGridFault,
} from './questionFault';

describe('firstEmptyConditionQuestion', () => {
  it('names the first question with an empty audience condition', () => {
    expect(firstEmptyConditionQuestion([{ id: 'x' }, { id: 'y', showIf: {} }])).toBe('y');
    expect(firstEmptyConditionQuestion([{ id: 'x', showIf: { promo: [1] } }])).toBeNull();
  });

  it('never names a file question: a form-level file refusal has no question to blame', () => {
    expect(firstEmptyConditionQuestion([{ id: 'f', type: 'file' } as any])).toBeNull();
  });
});

describe('firstItemsFaultQuestion', () => {
  it('names the grid with a duplicate row', () => {
    const items = [
      { id: 'a', type: 'short_text' },
      { id: 'g', type: 'matrix_single', rows: [{ value: 'R' }, { value: 'R' }], options: [] },
    ];
    expect(firstItemsFaultQuestion(items)).toBe('g');
  });

  it('names the grid with a duplicate column, and ignores a clean grid', () => {
    const dup = {
      id: 'g',
      type: 'matrix_multiple',
      rows: [],
      options: [{ label: 'A' }, { label: 'A' }],
    };
    const clean = {
      id: 'c',
      type: 'matrix_single',
      rows: [{ value: 'R' }],
      options: [{ label: 'A' }],
    };
    expect(firstItemsFaultQuestion([clean, dup])).toBe('g');
    expect(firstItemsFaultQuestion([clean])).toBeNull();
  });
});

describe('refusedProductGridFault', () => {
  const items = [
    { id: 'q1', type: 'short_text', label: 'Nom' },
    { id: 'g', type: 'product_grid', label: 'Sweat' },
  ];
  const refused = (code: string | null, itemId: string | null) =>
    new SocialApiError('refused', code, 400, null, null, itemId);

  it("names the grid a server-only refusal is about, in the editor's words", () => {
    // A cotisation tier the association does not sell: only the server can know it.
    expect(refusedProductGridFault(refused('PRODUCT_GRID_TIER_INVALID', 'g'), items)).toEqual({
      itemId: 'g',
      message: m.form_pgrid_problem_in_question({
        label: 'Sweat',
        problem: m.form_pgrid_refusal_tier(),
      }),
    });
    expect(
      refusedProductGridFault(refused('PRODUCT_GRID_PRICES_INCOMPLETE', 'g'), items)?.itemId
    ).toBe('g');
  });

  it('leaves the banner alone for any other refusal', () => {
    expect(refusedProductGridFault(refused('FORM_NOT_YOURS', 'g'), items)).toBeNull();
    // An answer code is no definition fault, and a plain error carries nothing.
    expect(refusedProductGridFault(refused('PRODUCT_GRID_EMPTY', 'g'), items)).toBeNull();
    expect(refusedProductGridFault(new Error('offline'), items)).toBeNull();
  });

  it('accuses a grid code that names no grid of the form, and draws nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(refusedProductGridFault(refused('PRODUCT_GRID_TIER_INVALID', 'q1'), items)).toBeNull();
    expect(refusedProductGridFault(refused('PRODUCT_GRID_TIER_INVALID', null), items)).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
