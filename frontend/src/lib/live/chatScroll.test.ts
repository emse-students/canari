import { describe, expect, it } from 'vitest';
import { CHAT_BOTTOM_SLACK, isAtBottom, onLinesAdded } from './chatScroll';

describe('isAtBottom', () => {
  it('is true at the exact bottom and within the slack', () => {
    expect(isAtBottom({ scrollHeight: 500, scrollTop: 300, clientHeight: 200 })).toBe(true);
    expect(
      isAtBottom({ scrollHeight: 500, scrollTop: 300 - CHAT_BOTTOM_SLACK + 1, clientHeight: 200 })
    ).toBe(true);
  });
  it('is false once scrolled up past the slack', () => {
    expect(
      isAtBottom({ scrollHeight: 500, scrollTop: 300 - CHAT_BOTTOM_SLACK, clientHeight: 200 })
    ).toBe(false);
    expect(isAtBottom({ scrollHeight: 500, scrollTop: 0, clientHeight: 200 })).toBe(false);
  });
  it('is true when the content fits without scrolling', () => {
    expect(isAtBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 200 })).toBe(true);
  });
});

describe('onLinesAdded', () => {
  it('follows and clears the unseen count when pinned', () => {
    expect(onLinesAdded(true, 3, 2)).toEqual({ follow: true, unseen: 0 });
  });
  it('counts the new lines instead of scrolling when reading back', () => {
    expect(onLinesAdded(false, 1, 2)).toEqual({ follow: false, unseen: 3 });
  });
  it('does nothing when no line was added', () => {
    expect(onLinesAdded(false, 4, 0)).toEqual({ follow: false, unseen: 4 });
    expect(onLinesAdded(true, 0, -1)).toEqual({ follow: false, unseen: 0 });
  });
});
