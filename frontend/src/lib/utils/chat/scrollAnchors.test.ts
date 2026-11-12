import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearConversationAnchors,
  firstRowEndingBelow,
  rememberConversationAnchor,
  resolveEntryAnchor,
  takeConversationAnchor,
  type ConversationAnchor,
} from './scrollAnchors';

const anchor: ConversationAnchor = { messageId: 'm42', windowStart: 10, offsetPx: -12 };

describe('the saved position of a conversation', () => {
  beforeEach(() => clearConversationAnchors());

  it('is returned once, then gone', () => {
    rememberConversationAnchor('c1', anchor);
    expect(takeConversationAnchor('c1')).toEqual(anchor);
    expect(takeConversationAnchor('c1')).toBeNull();
  });

  it('is per conversation, and null forgets (a reader who left at the bottom)', () => {
    rememberConversationAnchor('c1', anchor);
    rememberConversationAnchor('c2', { ...anchor, messageId: 'other' });
    rememberConversationAnchor('c1', null);
    expect(takeConversationAnchor('c1')).toBeNull();
    expect(takeConversationAnchor('c2')?.messageId).toBe('other');
  });

  it('a sign-out drops every one', () => {
    rememberConversationAnchor('c1', anchor);
    clearConversationAnchors();
    expect(takeConversationAnchor('c1')).toBeNull();
  });
});

describe('firstRowEndingBelow', () => {
  const bottoms = [40, 80, 120, 160, 200];
  const read = (i: number) => bottoms[i];

  it('finds the first row with any part below the limit', () => {
    expect(firstRowEndingBelow(5, read, 0)).toBe(0);
    expect(firstRowEndingBelow(5, read, 40)).toBe(1);
    expect(firstRowEndingBelow(5, read, 119)).toBe(2);
  });

  it('is -1 when every row ends above, or there is none', () => {
    expect(firstRowEndingBelow(5, read, 200)).toBe(-1);
    expect(firstRowEndingBelow(0, read, 0)).toBe(-1);
  });

  it('reads only O(log n) rows', () => {
    let reads = 0;
    firstRowEndingBelow(
      1024,
      (i) => {
        reads++;
        return i * 10 + 10;
      },
      5000
    );
    expect(reads).toBeLessThanOrEqual(11);
  });
});

describe('resolveEntryAnchor', () => {
  it('no anchor: the usual entry', () => {
    expect(resolveEntryAnchor(null, 5, 100)).toEqual({ kind: 'bottom', reason: 'none' });
  });

  it('an anchor that holds restores through the window that mounts its row', () => {
    expect(resolveEntryAnchor(anchor, 30, 100)).toEqual({
      kind: 'restore',
      windowStart: 10,
      messageId: 'm42',
      offsetPx: -12,
    });
  });

  it('a stored window below the target is lowered to the target so the row is mounted', () => {
    const d = resolveEntryAnchor({ ...anchor, windowStart: 80 }, 30, 100);
    expect(d).toMatchObject({ kind: 'restore', windowStart: 30 });
  });

  it('a message gone from the list is stale: fall back, naming why', () => {
    expect(resolveEntryAnchor(anchor, -1, 100)).toEqual({
      kind: 'bottom',
      reason: 'message-not-in-list',
    });
    expect(resolveEntryAnchor(anchor, 100, 100)).toMatchObject({ kind: 'bottom' });
  });

  it('a corrupt stored window or offset cannot reach the render window', () => {
    const d = resolveEntryAnchor({ messageId: 'm', windowStart: NaN, offsetPx: NaN }, 3, 10);
    expect(d).toEqual({ kind: 'restore', windowStart: 0, messageId: 'm', offsetPx: 0 });
  });
});
