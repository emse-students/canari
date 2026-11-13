import { editLockedItemIds, rowLockedItemIds, sameAnswer, type EditLockForm } from './answer-edit';

/** A form with one of each kind of question the lock rule reads. */
function form(over: Partial<EditLockForm> = {}): EditLockForm {
  return {
    items: [
      { id: 'q-text', type: 'short_text' },
      // A choice with a supplement: it decides the price.
      {
        id: 'q-meal',
        type: 'single_choice',
        options: [
          { id: 'o-none', priceModifier: 0 },
          { id: 'o-meal', priceModifier: 1200 },
        ],
      },
      // A choice with no supplement and not in the grid: free to change.
      { id: 'q-size', type: 'single_choice', options: [{ id: 's', priceModifier: 0 }] },
      { id: 'q-grid', type: 'product_grid' },
    ],
    priceMatrix: null,
    grantsCotisation: false,
    submitCondition: null,
    ...over,
  };
}

describe('editLockedItemIds', () => {
  it('locks a priced grid and a choice with a supplement, and nothing else', () => {
    expect([...editLockedItemIds(form(), false)].sort()).toEqual(['q-grid', 'q-meal']);
  });

  it('locks a question the price grid divides on, even without a supplement', () => {
    const matrix = {
      dimensions: [{ id: 'd', kind: 'answer', questionId: 'q-size', buckets: [] }],
      cells: {},
    } as unknown as EditLockForm['priceMatrix'];
    expect(editLockedItemIds(form({ priceMatrix: matrix }), false).has('q-size')).toBe(true);
  });

  it('locks the question that shows or hides a priced one, transitively', () => {
    const items = [
      { id: 'q-root', type: 'single_choice', options: [{ id: 'r', priceModifier: 0 }] },
      // Legacy pair: shown when q-root = r.
      {
        id: 'q-mid',
        type: 'single_choice',
        options: [{ id: 'm', priceModifier: 0 }],
        dependsOn: 'q-root',
        dependsValue: 'r',
      },
      {
        id: 'q-paid',
        type: 'single_choice',
        options: [{ id: 'p', priceModifier: 500 }],
        showIf: { answer: { questionId: 'q-mid', optionIds: ['m'] } },
      },
      { id: 'q-free', type: 'long_text' },
    ];
    expect([...editLockedItemIds(form({ items }), false)].sort()).toEqual([
      'q-mid',
      'q-paid',
      'q-root',
    ]);
  });

  it("locks a granting form's admission question once the grant is made, not before", () => {
    const granting = form({
      grantsCotisation: true,
      submitCondition: { answer: { questionId: 'q-text', optionIds: ['x'] } },
    });
    expect(editLockedItemIds(granting, false).has('q-text')).toBe(false);
    expect(editLockedItemIds(granting, true).has('q-text')).toBe(true);
    // A form that grants nothing never locks it.
    expect(editLockedItemIds({ ...granting, grantsCotisation: false }, true).has('q-text')).toBe(
      false
    );
  });

  it('a text question carrying a priced option is not a price (the TYPE decides)', () => {
    const items = [{ id: 'q', type: 'short_text', options: [{ id: 'o', priceModifier: 900 }] }];
    expect(editLockedItemIds(form({ items }), false).size).toBe(0);
  });
});

describe('rowLockedItemIds', () => {
  it('keeps locked what the row was priced on, even once the form no longer prices it', () => {
    // The grid the row was charged on is now a plain text question; its dependant is free today.
    const items = [
      { id: 'q-root', type: 'single_choice', options: [{ id: 'r', priceModifier: 0 }] },
      {
        id: 'q-was-grid',
        type: 'short_text',
        showIf: { answer: { questionId: 'q-root', optionIds: ['r'] } },
      },
      { id: 'q-free', type: 'long_text' },
    ];
    const today = form({ items });
    expect(editLockedItemIds(today, false).size).toBe(0);
    const locked = rowLockedItemIds(today, {
      cotisationGrantedAt: null,
      lines: [{ itemId: 'q-was-grid' }],
    });
    // The question named by the row's lines, and the one that shows it.
    expect([...locked].sort()).toEqual(['q-root', 'q-was-grid']);
  });

  it('reads the grant from the row', () => {
    const granting = form({
      grantsCotisation: true,
      submitCondition: { answer: { questionId: 'q-text', optionIds: ['x'] } },
    });
    expect(
      rowLockedItemIds(granting, { cotisationGrantedAt: new Date(), lines: null }).has('q-text')
    ).toBe(true);
    expect(
      rowLockedItemIds(granting, { cotisationGrantedAt: null, lines: null }).has('q-text')
    ).toBe(false);
  });
});

describe('sameAnswer', () => {
  it('treats every empty spelling as no answer', () => {
    for (const empty of [undefined, null, '', [], {}, { row: '' }, { 'a:b': 0 }]) {
      expect(sameAnswer(empty, undefined)).toBe(true);
    }
  });

  it('reads a multiple choice as a set', () => {
    expect(sameAnswer(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameAnswer(['a'], ['a', 'b'])).toBe(false);
  });

  it('reads a grid by its non-empty cells, whatever their order', () => {
    expect(sameAnswer({ 'v:m': 2, 'n:l': 0 }, { 'v:m': 2 })).toBe(true);
    expect(sameAnswer({ 'v:m': 2 }, { 'v:m': 3 })).toBe(false);
    expect(sameAnswer({ r1: 'a', r2: '' }, { r1: 'a' })).toBe(true);
  });

  it('keeps a top-level zero: a scale answered 0 is an answer', () => {
    expect(sameAnswer(0, undefined)).toBe(false);
    expect(sameAnswer(0, 0)).toBe(true);
  });

  it('tells a changed choice apart', () => {
    expect(sameAnswer('o-meal', 'o-none')).toBe(false);
  });
});
