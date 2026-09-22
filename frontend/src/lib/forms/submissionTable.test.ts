import { describe, expect, it } from 'vitest';
import {
  answerColumns,
  answeredItems,
  maxAnswerColumns,
  panelAddsNothing,
} from './submissionTable';
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

describe('maxAnswerColumns', () => {
  it('hands a free form the width the status and amount columns would have taken', () => {
    expect(maxAnswerColumns(false)).toBe(maxAnswerColumns(true) + 1);
  });

  it('is the narrower budget that `answerColumns` defaults to', () => {
    const items = Array.from({ length: 9 }, (_, n) => item({ id: `q${n}`, type: 'short_text' }));
    expect(answerColumns(items)).toHaveLength(maxAnswerColumns(true));
    expect(answerColumns(items, maxAnswerColumns(false))).toHaveLength(maxAnswerColumns(false));
  });
});

describe('panelAddsNothing', () => {
  const asso = item({ id: 'asso', type: 'short_text' });
  const why = item({ id: 'why', type: 'long_text' });
  const nothingClipped = () => false;
  const everythingClipped = () => true;

  it('is true when every answer is already a column and fits its cell', () => {
    expect(panelAddsNothing([{ item: asso, text: 'BDS' }], [asso], nothingClipped)).toBe(true);
  });

  it('is false for an answer no column holds', () => {
    expect(panelAddsNothing([{ item: why, text: 'Un paragraphe' }], [asso], nothingClipped)).toBe(
      false
    );
  });

  // The LENGTH of the text says nothing here, and saying it was the defect: this took an answer
  // against a 25-character constant until 2026-09-22 and a reader met rows that expanded beside
  // rows that did not. Only the cell knows, so only the cell is asked.
  it('is false for an answer its own column is clipping, whatever its length', () => {
    const short = [{ item: asso, text: 'BDS' }];
    expect(panelAddsNothing(short, [asso], everythingClipped)).toBe(false);

    const long = [{ item: asso, text: 'x'.repeat(400) }];
    expect(panelAddsNothing(long, [asso], nothingClipped)).toBe(true);
  });

  it('asks only about the answers it is deciding on', () => {
    const asked: string[] = [];
    panelAddsNothing([{ item: asso, text: 'BDS' }], [asso], (itemId) => {
      asked.push(itemId);
      return false;
    });
    expect(asked).toEqual(['asso']);
  });

  // The card layout draws no answer column at all, so it asks with an empty list and always keeps
  // its control - the same call that disables the table row's.
  it('is decided by the columns the CALLER draws, not by the form', () => {
    const answered = [{ item: asso, text: 'BDS' }];
    expect(panelAddsNothing(answered, [asso], nothingClipped)).toBe(true);
    expect(panelAddsNothing(answered, [], nothingClipped)).toBe(false);
  });

  it('is true for a response that answered nothing, whatever is drawn', () => {
    expect(panelAddsNothing([], [], nothingClipped)).toBe(true);
    expect(panelAddsNothing([], [asso], everythingClipped)).toBe(true);
  });
});
