import { describe, it, expect } from 'vitest';
import { capVoters } from './pollVoters';

describe('capVoters', () => {
  it('leaves a short list whole', () => {
    expect(capVoters([1, 2, 3])).toEqual({ shown: [1, 2, 3], extra: 0 });
  });
  it('caps at 10 and counts the rest', () => {
    const r = capVoters(Array.from({ length: 45 }, (_, i) => i));
    expect(r.shown).toHaveLength(10);
    expect(r.extra).toBe(35);
  });
  it('handles an empty list', () => {
    expect(capVoters([])).toEqual({ shown: [], extra: 0 });
  });
});
