import { describe, expect, it } from 'vitest';
import {
  AUTHORABLE_QUESTION_TYPES,
  AUTHORABLE_QUESTION_TYPE_VALUES,
  FILLABLE_QUESTION_TYPE_VALUES,
  QUESTION_TYPES,
} from './questionTypes';

describe('the question types the builders offer', () => {
  it('names only types of the canonical list', () => {
    const canonical = QUESTION_TYPES.map((t) => t.value);
    for (const value of AUTHORABLE_QUESTION_TYPE_VALUES) expect(canonical).toContain(value);
    expect(AUTHORABLE_QUESTION_TYPES.map((t) => t.value)).toEqual([
      ...AUTHORABLE_QUESTION_TYPE_VALUES,
    ]);
  });

  it('does not offer the priced grid while it has no editor (WP-G3): a save would refuse it', () => {
    expect(QUESTION_TYPES.map((t) => t.value)).toContain('product_grid');
    expect(AUTHORABLE_QUESTION_TYPES.map((t) => t.value)).not.toContain('product_grid');
  });

  it('offers every other type', () => {
    const missing = QUESTION_TYPES.map((t) => t.value).filter(
      (value) => value !== 'product_grid' && !AUTHORABLE_QUESTION_TYPE_VALUES.includes(value)
    );
    expect(missing).toEqual([]);
  });

  it('the fill page draws every canonical type, the priced grid included (WP-G2)', () => {
    const canonical = QUESTION_TYPES.map((t) => t.value);
    for (const value of FILLABLE_QUESTION_TYPE_VALUES) expect(canonical).toContain(value);
    expect([...FILLABLE_QUESTION_TYPE_VALUES].sort()).toEqual([...canonical].sort());
    expect(FILLABLE_QUESTION_TYPE_VALUES).toContain('product_grid');
  });
});
