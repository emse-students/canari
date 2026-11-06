import type { FormItem } from './api';
import {
  firstMissingAnswer,
  initialSelections,
  isItemAnswered,
  pricedQuestionsAwaitingAnswer,
  selectionsFromAnswers,
  visibleAnswers,
  visibleItems,
} from './fillAnswers';

const q = (over: Partial<FormItem> & { id: string }): FormItem => ({
  label: over.id,
  required: false,
  type: 'short_text',
  ...over,
});

describe('initialSelections', () => {
  it('gives each type the empty shape its inputs bind to', () => {
    const selections = initialSelections([
      q({ id: 't' }),
      q({ id: 'm', type: 'multiple_choice' }),
      q({ id: 'g', type: 'matrix_multiple', rows: ['r1'] }),
      q({ id: 's', type: 'matrix_single', rows: ['r1'] }),
    ]);
    expect(selections).toEqual({ t: '', m: [], g: { r1: [] }, s: { r1: '' } });
  });
});

describe('isItemAnswered and firstMissingAnswer agree', () => {
  // The defect the extraction closed: the bar counted a 0 as answered and the button refused it.
  it('counts 0 on a linear scale as an answer, on both sides', () => {
    const scale = q({ id: 'n', type: 'linear_scale', required: true });
    expect(isItemAnswered(scale, 0)).toBe(true);
    expect(firstMissingAnswer([scale], { n: 0 })).toBeNull();
  });

  it('names the first required question left empty, and skips optional ones', () => {
    const items = [q({ id: 'a' }), q({ id: 'b', required: true, label: 'Nom' })];
    expect(firstMissingAnswer(items, { a: '', b: '' })).toEqual({ kind: 'answer', label: 'Nom' });
  });

  it('asks for a selection on an empty choice list', () => {
    const items = [q({ id: 'm', type: 'multiple_choice', required: true })];
    expect(firstMissingAnswer(items, { m: [] })?.kind).toBe('select');
  });

  // D5 (decided 2026-11-06): a required grid wants ONE row, unless it asks for every row.
  it('takes a required grid answered by one row', () => {
    const item = q({ id: 'g', type: 'matrix_single', required: true, rows: ['r1', 'r2'] });
    expect(firstMissingAnswer([item], { g: { r1: 'x', r2: '' } })).toBeNull();
    expect(isItemAnswered(item, { r1: 'x', r2: '' })).toBe(true);
    expect(firstMissingAnswer([item], { g: { r1: '', r2: '' } })).toEqual({
      kind: 'matrix',
      label: 'g',
    });
  });

  it('names the row left empty of a grid that asks for every row', () => {
    const item = q({
      id: 'g',
      type: 'matrix_single',
      required: true,
      rows: ['r1', 'r2'],
      requireEveryRow: true,
    });
    expect(firstMissingAnswer([item], { g: { r1: 'x', r2: '' } })).toEqual({
      kind: 'row',
      label: 'g',
      row: 'r2',
    });
    expect(isItemAnswered(item, { r1: 'x', r2: '' })).toBe(false);
  });

  it('asks to update the app for a required question of a type it does not know', () => {
    const item = q({ id: 'p', type: 'product_grid', required: true, label: 'Sweat' });
    expect(firstMissingAnswer([item], { p: { a: 1 } })).toEqual({ kind: 'update', label: 'Sweat' });
  });
});

describe('visibleItems', () => {
  const items = [
    q({ id: 'menu', type: 'single_choice' }),
    q({ id: 'veg', showIf: { answer: { questionId: 'menu', optionIds: ['v'] } } }),
    q({ id: 'legacy', dependsOn: 'menu', dependsValue: 'v' }),
  ];

  it('shows a conditional question only on the answer it waits for', () => {
    expect(visibleItems(items, { menu: 'm' }).map((i) => i.id)).toEqual(['menu']);
    expect(visibleItems(items, { menu: 'v' }).map((i) => i.id)).toEqual(['menu', 'veg', 'legacy']);
  });

  it('hides what the server hid, and what depends on it', () => {
    expect(visibleItems(items, { menu: 'v' }, new Set(['menu'])).map((i) => i.id)).toEqual([]);
  });

  it('sends only the answers to visible questions', () => {
    const shown = visibleItems(items, { menu: 'm', veg: 'stale' });
    expect(visibleAnswers(shown, { menu: 'm', veg: 'stale' })).toEqual({ menu: 'm' });
  });
});

describe('pricedQuestionsAwaitingAnswer', () => {
  // Mi 9T, v1.2.9-alpha.3: "Combinaison indisponible" before any answer was chosen.
  const formation = q({ id: 'formation', type: 'single_choice', required: true });
  const promo = q({ id: 'promo', type: 'single_choice' });

  it('a required priced question left blank has chosen no cell yet', () => {
    const pending = pricedQuestionsAwaitingAnswer([formation, promo], ['formation', 'promo'], {
      formation: '',
      promo: '',
    });
    expect([...pending]).toEqual(['formation']);
  });

  it('an answer, an optional blank, a hidden or an unpriced question awaits nothing', () => {
    expect(
      pricedQuestionsAwaitingAnswer([formation], ['formation'], { formation: 'icm' }).size
    ).toBe(0);
    expect(pricedQuestionsAwaitingAnswer([promo], ['promo'], { promo: '' }).size).toBe(0);
    expect(pricedQuestionsAwaitingAnswer([], ['formation'], { formation: '' }).size).toBe(0);
    expect(pricedQuestionsAwaitingAnswer([formation], [], { formation: '' }).size).toBe(0);
  });
});

describe('visibleAnswers sends only what is answered (D1, D3)', () => {
  it('leaves out empty questions and a grid with no answered row, and strips empty rows', () => {
    const items = [
      q({ id: 't' }),
      q({ id: 'm', type: 'multiple_choice' }),
      q({ id: 'n', type: 'linear_scale' }),
      q({ id: 'g', type: 'matrix_single', rows: ['r1', 'r2'] }),
      q({ id: 'e', type: 'matrix_multiple', rows: ['r1'] }),
    ];
    const sent = visibleAnswers(items, {
      t: '',
      m: [],
      n: 0,
      g: { r1: 'c1', r2: '' },
      e: { r1: [] },
    });
    expect(sent).toEqual({ n: 0, g: { r1: 'c1' } });
  });

  it('sends no key for a form of many unanswered questions', () => {
    const items = Array.from({ length: 80 }, (_, i) => q({ id: `q${i}` }));
    expect(visibleAnswers(items, initialSelections(items))).toEqual({});
  });
});

describe('selectionsFromAnswers', () => {
  it('seeds the rows a stored grid answer left out, so every row input binds', () => {
    const items = [q({ id: 'g', type: 'matrix_single', rows: ['r1', 'r2'] }), q({ id: 't' })];
    expect(selectionsFromAnswers(items, { g: { r1: 'c1' } })).toEqual({
      g: { r1: 'c1', r2: '' },
      t: '',
    });
  });
});
