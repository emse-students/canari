import { beforeEach, describe, expect, it } from 'vitest';
import { parsePickCopyEvent, pickCopy } from './pickCopyState.svelte';

describe('pickCopyState', () => {
  beforeEach(() => pickCopy.reset());

  it('types the four native events and refuses anything else', () => {
    expect(parsePickCopyEvent({ phase: 'start', name: 'a.pdf' })).toEqual({
      phase: 'start',
      name: 'a.pdf',
    });
    expect(parsePickCopyEvent({ phase: 'progress', percent: 40 })).toEqual({
      phase: 'progress',
      percent: 40,
    });
    expect(parsePickCopyEvent({ phase: 'end' })).toEqual({ phase: 'end' });
    expect(
      parsePickCopyEvent({ phase: 'refused', reason: 'too-large', name: 'a.pdf', limitMb: 200 })
    ).toEqual({ phase: 'refused', reason: 'too-large', name: 'a.pdf', limitMb: 200 });
    expect(parsePickCopyEvent({ phase: 'refused', reason: 'other', name: 'a', limitMb: 1 })).toBe(
      null
    );
    expect(parsePickCopyEvent({ phase: 'progress' })).toBe(null);
    expect(parsePickCopyEvent(null)).toBe(null);
  });

  it('draws a read from its start to its end, percent clamped', () => {
    pickCopy.apply({ phase: 'start', name: 'a.pdf' });
    expect(pickCopy.reading).toEqual({ percent: null });
    pickCopy.apply({ phase: 'progress', percent: 140 });
    expect(pickCopy.reading).toEqual({ percent: 100 });
    pickCopy.apply({ phase: 'end' });
    expect(pickCopy.reading).toBeNull();
  });

  it('remembers a size refusal by name, and says it once', () => {
    pickCopy.apply({ phase: 'refused', reason: 'too-large', name: 'big.pdf', limitMb: 200 });
    expect(pickCopy.takeRefusal('other.pdf')).toBeNull();
    expect(pickCopy.takeRefusal('big.pdf')).toBe(200);
    expect(pickCopy.takeRefusal('big.pdf')).toBeNull();
  });
});
