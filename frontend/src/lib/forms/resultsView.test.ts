import { describe, expect, it } from 'vitest';
import { formatMean, hasResultQuestions, longest, percentOf } from './resultsView';

describe('percentOf', () => {
  it("is a share of the question's own answers, rounded", () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(3, 3)).toBe(100);
  });

  it('is 0, not NaN, when nobody answered', () => {
    expect(percentOf(0, 0)).toBe(0);
  });

  it('may pass 100 summed over a multiple choice, which is why the denominator is stated', () => {
    expect(percentOf(4, 5) + percentOf(3, 5)).toBe(140);
  });
});

describe('formatMean', () => {
  it("writes one decimal in the reader's locale", () => {
    expect(formatMean(4.5, 'en')).toBe('4.5');
    expect(formatMean(4.5, 'fr')).toBe('4,5');
    expect(formatMean(3, 'en')).toBe('3.0');
  });

  it('writes a dash for a scale nobody answered', () => {
    expect(formatMean(null, 'en')).toBe('-');
  });
});

describe('longest', () => {
  it('is never 0, so a bar never divides by it', () => {
    expect(longest([])).toBe(1);
    expect(longest([0, 0])).toBe(1);
    expect(longest([2, 7, 3])).toBe(7);
  });
});

describe('hasResultQuestions', () => {
  it('is true for a form with any summarisable question', () => {
    expect(hasResultQuestions([{ type: 'file' }, { type: 'linear_scale' }])).toBe(true);
    expect(hasResultQuestions([{ type: 'long_text' }])).toBe(true);
  });

  it('is false for a form of nothing that has results', () => {
    expect(hasResultQuestions([{ type: 'file' }])).toBe(false);
    expect(hasResultQuestions([])).toBe(false);
  });
});
