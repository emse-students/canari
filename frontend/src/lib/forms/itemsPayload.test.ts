import { describe, expect, it } from 'vitest';
import { toFormItemsPayload } from './itemsPayload';

describe('toFormItemsPayload', () => {
  it('turns a choice option supplement into cents', () => {
    const [item] = toFormItemsPayload([
      { id: 'q1', type: 'single_choice', options: [{ id: 'o1', label: 'A', priceModifier: 2.5 }] },
    ]);
    expect(item.options?.[0].priceModifier).toBe(250);
  });

  // A question turned into a matrix keeps its options as columns; their old supplements can never
  // charge, so they are not stored. Control (2026-10-22): the type check removed -> this fails.
  it('drops the supplements of a question that is no longer a choice', () => {
    const [item] = toFormItemsPayload([
      {
        id: 'q1',
        type: 'matrix_single',
        rows: ['r1'],
        options: [{ id: 'o1', label: 'Oui', priceModifier: 5 }],
      },
    ]);
    expect(item.options?.[0]).toMatchObject({ id: 'o1', priceModifier: 0 });
  });
});
