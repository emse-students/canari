import { describe, expect, it } from 'vitest';
import { answerColumns, answeredItems } from './submissionTable';
import type { FormItem } from './api';

/**
 * The layout one form's responses take. What is asserted is WHICH questions become columns and
 * which answers the panel lists - the reading of a single value is `answerText.test.ts`.
 */

const item = (over: Partial<FormItem> = {}): FormItem => ({
  id: 'q1',
  label: 'Question',
  required: false,
  type: 'short_text',
  ...over,
});

describe('answerColumns', () => {
  it('takes the short types and leaves the unbounded ones to the panel', () => {
    const items = [
      item({ id: 'a', type: 'short_text' }),
      item({ id: 'b', type: 'long_text' }),
      item({ id: 'c', type: 'dropdown' }),
      item({ id: 'd', type: 'multiple_choice' }),
      item({ id: 'e', type: 'matrix_single' }),
    ];
    expect(answerColumns(items).map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('never makes a column of a conditional question', () => {
    const items = [
      item({ id: 'a', type: 'short_text' }),
      item({ id: 'b', type: 'short_text', dependsOn: 'a', dependsValue: 'o1' }),
      item({ id: 'c', type: 'dropdown', showIf: { promo: { values: [2024] } } }),
    ];
    expect(answerColumns(items).map((i) => i.id)).toEqual(['a']);
  });

  it('stops at the cap however many the form has', () => {
    const items = Array.from({ length: 9 }, (_, n) => item({ id: `q${n}`, type: 'short_text' }));
    expect(answerColumns(items)).toHaveLength(3);
  });

  it('adds no column at all to a form of paragraphs', () => {
    expect(answerColumns([item({ type: 'long_text' })])).toEqual([]);
  });
});

describe('answeredItems', () => {
  const items = [item({ id: 'a', label: 'Ton asso ?' }), item({ id: 'b', label: 'Budget' })];

  it('reads in the form order, not the order the answers were stored in', () => {
    expect(answeredItems(items, { b: '120', a: "Humani'Mines" }).map((x) => x.item.label)).toEqual([
      'Ton asso ?',
      'Budget',
    ]);
  });

  it('drops the questions this person left blank', () => {
    expect(answeredItems(items, { a: "Humani'Mines", b: '' })).toHaveLength(1);
  });

  // An answer whose question is gone has no label, so it is not a reading of anything. The export
  // iterates the items for the same reason.
  it('ignores an answer to a question the form no longer has', () => {
    expect(answeredItems(items, { deleted: 'orphan' })).toEqual([]);
  });

  it('is empty for a submission with no answers at all', () => {
    expect(answeredItems(items, undefined)).toEqual([]);
    expect(answeredItems(items, {})).toEqual([]);
  });
});
