import { isVerticalDismissDrag, shouldDismissOnRelease } from './lightboxSwipeDismiss';

describe('lightboxSwipeDismiss', () => {
  it('tracks a genuinely vertical drag', () => {
    expect(isVerticalDismissDrag(5, 20)).toBe(true);
    expect(isVerticalDismissDrag(0, 0)).toBe(true);
  });

  it('ignores a mostly-horizontal drag', () => {
    expect(isVerticalDismissDrag(30, 10)).toBe(false);
  });

  it('dismisses past the threshold in either direction', () => {
    expect(shouldDismissOnRelease(150)).toBe(true);
    expect(shouldDismissOnRelease(-150)).toBe(true);
  });

  it('snaps back under the threshold', () => {
    expect(shouldDismissOnRelease(80)).toBe(false);
    expect(shouldDismissOnRelease(-80)).toBe(false);
  });

  it('does not dismiss exactly at the threshold', () => {
    expect(shouldDismissOnRelease(110, 110)).toBe(false);
    expect(shouldDismissOnRelease(111, 110)).toBe(true);
  });
});
