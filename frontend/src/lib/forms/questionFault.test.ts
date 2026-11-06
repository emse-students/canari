import { describe, it, expect } from 'vitest';
import { firstEmptyConditionQuestion, firstItemsFaultQuestion } from './questionFault';

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
