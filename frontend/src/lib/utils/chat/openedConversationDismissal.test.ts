import { describe, expect, it } from 'vitest';
import { createOpenedConversationDismissal } from './openedConversationDismissal';

describe('openedConversationDismissal', () => {
  it('hands a reading over once, however many times the receipt effect runs', () => {
    const d = createOpenedConversationDismissal();
    expect(d.take('g1')).toBe(true);
    expect(d.take('g1')).toBe(false);
    expect(d.take('g1')).toBe(false);
  });

  it('hands the next conversation over, and the first again when it is read anew', () => {
    const d = createOpenedConversationDismissal();
    expect(d.take('g1')).toBe(true);
    expect(d.take('channel_c1')).toBe(true);
    expect(d.take('g1')).toBe(true);
  });

  it('re-arms when the reading ends, so a reaction raised meanwhile is dismissed on return', () => {
    const d = createOpenedConversationDismissal();
    expect(d.take('g1')).toBe(true);
    d.reset();
    expect(d.take('g1')).toBe(true);
  });
});
