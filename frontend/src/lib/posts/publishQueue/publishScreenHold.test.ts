import { describe, expect, it } from 'vitest';
import type { PublishView } from './publishQueue';
import { publishHoldsTheScreen } from './publishScreenHold';

const row = (phase: PublishView['phase']): PublishView => ({
  id: phase,
  phase,
  index: 0,
  count: 1,
  fraction: 0,
  step: 0,
});

describe('publishHoldsTheScreen', () => {
  it.each(['preparing', 'uploading', 'publishing'] as const)(
    'holds the screen while a post is %s',
    (phase) => {
      expect(publishHoldsTheScreen([row('paused'), row(phase)])).toBe(true);
    }
  );

  it.each(['queued', 'waiting', 'paused', 'withdrawing', 'failed'] as const)(
    'never holds it for a post that is %s: a queue that cannot progress keeps no phone awake',
    (phase) => {
      expect(publishHoldsTheScreen([row(phase)])).toBe(false);
    }
  );

  it('an empty queue holds nothing', () => {
    expect(publishHoldsTheScreen([])).toBe(false);
  });
});
