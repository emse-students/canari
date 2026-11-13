import { m } from '$lib/paraglide/messages';
import type { FormItem } from './api';
import {
  allRequiredAnswered,
  editedAnswers,
  firstMissingAnswer,
  initialSelections,
  isItemAnswered,
  missingAnswerMessage,
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
    expect(firstMissingAnswer(items, { a: '', b: '' })).toEqual({
      itemId: 'b',
      kind: 'answer',
      label: 'Nom',
    });
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
      itemId: 'g',
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
      itemId: 'g',
      kind: 'row',
      label: 'g',
      row: 'r2',
    });
    expect(isItemAnswered(item, { r1: 'x', r2: '' })).toBe(false);
  });

  it('holds a priced grid until one unit is ordered, and starts it as an empty order', () => {
    const grid = q({ id: 'pg', type: 'product_grid', required: true, label: 'Sweat' });
    expect(initialSelections([grid])).toEqual({ pg: {} });
    expect(isItemAnswered(grid, {})).toBe(false);
    expect(isItemAnswered(grid, { 'r:c': 0 })).toBe(false);
    expect(firstMissingAnswer([grid], { pg: {} })).toEqual({ itemId: null, kind: 'order' });
    expect(isItemAnswered(grid, { 'r:c': 2 })).toBe(true);
    expect(firstMissingAnswer([grid], { pg: { 'r:c': 2 } })).toBeNull();
    expect(visibleAnswers([grid], { pg: {} })).toEqual({});
    expect(visibleAnswers([grid], { pg: { 'r:c': 2 } })).toEqual({ pg: { 'r:c': 2 } });
  });

  it('asks one unit of the ORDER, never of each grid: an untouched grid of two is no fault', () => {
    const sweat = q({ id: 'sweat', type: 'product_grid', required: true, label: 'Sweat' });
    const veste = q({ id: 'veste', type: 'product_grid', required: true, label: 'Veste' });
    const name = q({ id: 'nom', type: 'short_text', required: true, label: 'Nom' });
    const items = [name, sweat, veste];
    const empty = initialSelections(items);
    // A required question is still named first, on its card...
    expect(firstMissingAnswer(items, empty)).toEqual({
      itemId: 'nom',
      kind: 'answer',
      label: 'Nom',
    });
    // ...then the empty order, the form's and no card's.
    const named = { ...empty, nom: 'Ada' };
    const missing = firstMissingAnswer(items, named);
    expect(missing).toEqual({ itemId: null, kind: 'order' });
    expect(missingAnswerMessage(missing!)).toBe(m.form_view_error_order_empty());
    // One unit in EITHER grid sends the form; the untouched grid is left out of the payload.
    const veste1 = { ...named, veste: { 'r:c': 1 } };
    expect(firstMissingAnswer(items, veste1)).toBeNull();
    expect(visibleAnswers(items, veste1)).toEqual({ nom: 'Ada', veste: { 'r:c': 1 } });
  });

  it('gates the end of the form on the ORDER, never on each grid', () => {
    const sweat = q({ id: 'sweat', type: 'product_grid', required: true });
    const veste = q({ id: 'veste', type: 'product_grid', required: true });
    expect(allRequiredAnswered([sweat, veste], { sweat: {}, veste: {} })).toBe(false);
    expect(allRequiredAnswered([sweat, veste], { sweat: {}, veste: { 'r:c': 1 } })).toBe(true);
  });

  it('asks no order of a form whose grids are all hidden from this person', () => {
    const name = q({ id: 'nom', type: 'short_text', required: true, label: 'Nom' });
    expect(firstMissingAnswer([name], { nom: 'Ada' })).toBeNull();
  });

  it('asks to update the app for a required question of a type it does not know', () => {
    const item = q({ id: 'p', type: 'gift_card', required: true, label: 'Carte' });
    expect(firstMissingAnswer([item], { p: { a: 1 } })).toEqual({
      itemId: 'p',
      kind: 'update',
      label: 'Carte',
    });
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

describe('editedAnswers', () => {
  it('sends the visible answers less the locked questions, which the server keeps', () => {
    const items = [q({ id: 't' }), q({ id: 'meal', type: 'single_choice' })];
    expect(editedAnswers(items, { t: 'new', meal: 'o-meal' }, ['meal'])).toEqual({ t: 'new' });
    expect(editedAnswers(items, { t: 'new', meal: 'o-meal' }, [])).toEqual({
      t: 'new',
      meal: 'o-meal',
    });
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
