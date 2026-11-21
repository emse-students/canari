import { describe, expect, it } from 'vitest';
import { createOpenedConversationDismissal } from './openedConversationDismissal';

describe('openedConversationDismissal', () => {
  it('hands a reading over once at a given mark, however many times the receipt effect runs', () => {
    const d = createOpenedConversationDismissal();
    expect(d.take('g1', 10)).toBe(true);
    expect(d.take('g1', 10)).toBe(false);
    expect(d.take('g1', 5)).toBe(false);
  });

  it('hands over again when the mark advances - a first run at a stale mark is not the last word', () => {
    const d = createOpenedConversationDismissal();
    expect(d.take('g1', 0)).toBe(true);
    expect(d.take('g1', 0)).toBe(false);
    expect(d.take('g1', 120)).toBe(true);
    expect(d.take('g1', 120)).toBe(false);
  });

  it('hands the next conversation over, and the first again when it is read anew', () => {
    const d = createOpenedConversationDismissal();
    expect(d.take('g1', 10)).toBe(true);
    expect(d.take('channel_c1', 10)).toBe(true);
    expect(d.take('g1', 10)).toBe(true);
  });

  it('re-arms when the reading ends, so a reaction raised meanwhile is dismissed on return', () => {
    const d = createOpenedConversationDismissal();
    expect(d.take('g1', 10)).toBe(true);
    d.reset();
    expect(d.take('g1', 10)).toBe(true);
  });

  it('does not spend a hand-over the native side refused', () => {
    const d = createOpenedConversationDismissal();
    expect(d.take('g1', 10)).toBe(true);
    d.unspend();
    expect(d.take('g1', 10)).toBe(true);
  });
});
