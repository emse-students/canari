import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimTouchMove } from './touchClaim';

afterEach(() => vi.restoreAllMocks());

describe('claimTouchMove', () => {
  it('prevents the default of a cancelable move and says it is claimed', () => {
    const preventDefault = vi.fn();
    expect(claimTouchMove({ cancelable: true, preventDefault })).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('never calls preventDefault on a move the engine already scrolls (it only logs a warning)', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const preventDefault = vi.fn();
    expect(claimTouchMove({ cancelable: false, preventDefault })).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
