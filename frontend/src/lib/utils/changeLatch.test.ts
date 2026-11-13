import { describe, expect, it } from 'vitest';
import { createChangeLatch } from './changeLatch';

describe('createChangeLatch', () => {
  it('is true on first sight, false on a repeat, true again when the value moves', () => {
    const latch = createChangeLatch();
    expect(latch.changed('g1', 'kept')).toBe(true);
    expect(latch.changed('g1', 'kept')).toBe(false);
    expect(latch.changed('g2', 'kept')).toBe(true);
    expect(latch.changed('g1', 'removed')).toBe(true);
    expect(latch.changed('g1', 'removed')).toBe(false);
  });

  it('reset forgets everything', () => {
    const latch = createChangeLatch();
    latch.changed('g1', 'kept');
    latch.reset();
    expect(latch.changed('g1', 'kept')).toBe(true);
  });
});
