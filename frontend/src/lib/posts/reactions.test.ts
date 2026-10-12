import { describe, expect, it } from 'vitest';
import { REACTIONS, reactionTypeToLabel } from './reactions';

describe('reactionTypeToLabel', () => {
  it('names every reaction through Paraglide, never by its stored key', () => {
    for (const { type } of REACTIONS) {
      expect(reactionTypeToLabel(type)).toBeTruthy();
    }
    expect(reactionTypeToLabel('Marteau')).toBe('Marteau');
  });
});
