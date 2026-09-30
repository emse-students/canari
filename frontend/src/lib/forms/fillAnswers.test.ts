import type { FormItem } from './api';
import {
  firstMissingAnswer,
  initialSelections,
  isItemAnswered,
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

  it('names the row of a matrix left empty', () => {
    const item = q({ id: 'g', type: 'matrix_single', required: true, rows: ['r1', 'r2'] });
    expect(firstMissingAnswer([item], { g: { r1: 'x', r2: '' } })).toEqual({
      kind: 'row',
      label: 'g',
      row: 'r2',
    });
    expect(isItemAnswered(item, { r1: 'x', r2: '' })).toBe(false);
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
