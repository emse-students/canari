import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/utils/Log', () => ({ Log: { d: vi.fn(), w: vi.fn(), e: vi.fn() } }));

import { callView, callStatusKind } from './callView.svelte';

describe('callStatusKind', () => {
  it('reads the ring on each side', () => {
    expect(callStatusKind('incoming', null, false)).toBe('incoming');
    expect(callStatusKind('calling', null, false)).toBe('ringing');
  });

  it('is not live at the tap: incall without a connected media path is connecting', () => {
    expect(callStatusKind('incall', null, false)).toBe('connecting');
  });

  it('is live once connected, and reconnecting while the path is down', () => {
    expect(callStatusKind('incall', 1, false)).toBe('live');
    expect(callStatusKind('incall', 1, true)).toBe('reconnecting');
  });

  it('reads ended and idle as themselves', () => {
    expect(callStatusKind('ended', 1, false)).toBe('ended');
    expect(callStatusKind('idle', null, false)).toBe('idle');
  });
});

describe('callView', () => {
  it('opens full screen, minimises to the banner, expands back and resets for the next call', () => {
    expect(callView.minimised).toBe(false);
    callView.minimise();
    expect(callView.minimised).toBe(true);
    callView.expand();
    expect(callView.minimised).toBe(false);
    callView.minimise();
    callView.reset();
    expect(callView.minimised).toBe(false);
  });
});
