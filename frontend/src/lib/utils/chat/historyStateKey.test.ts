import { describe, it, expect } from 'vitest';
import type { StoredMessage } from '$lib/db';
import { canonicalMessageState, historyStateKey, parseHistoryStateKey } from './historyStateKey';

/**
 * The state key is a rule BOTH devices apply, and a disagreement does not fail loudly - it declares
 * two conversations identical and loses the difference, or declares them different for ever and
 * exchanges a digest on every connect. So every rule is pinned here rather than observed on a phone.
 */

const T = 1_700_000_000_000;

function msg(id: string, over: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id,
    conversationId: 'g1',
    senderId: 'user-a',
    content: 'hello',
    timestamp: T,
    ...over,
  } as StoredMessage;
}

describe('historyStateKey - what two devices agree on', () => {
  it('gives the same key to the same messages in any order', async () => {
    // The fold is XOR, so nothing about the key may depend on the order a store is walked in - and
    // in particular not on a sort, which two devices in different locales would do differently.
    const a = [msg('m1'), msg('m2'), msg('m3')];
    expect(await historyStateKey(a)).toBe(await historyStateKey([...a].reverse()));
  });

  it('gives the same key to the same reactions in any order', async () => {
    // Reactions are a set stored as an array: two devices that received the same two in opposite
    // orders hold the same state and must say so.
    const forward = msg('m1', {
      reactions: [
        { emoji: '👍', userId: 'user-b', at: 10 },
        { emoji: '🎉', userId: 'user-c', at: 20 },
      ],
    });
    const backward = msg('m1', {
      reactions: [
        { emoji: '🎉', userId: 'user-c', at: 20 },
        { emoji: '👍', userId: 'user-b', at: 10 },
      ],
    });
    expect(await historyStateKey([forward])).toBe(await historyStateKey([backward]));
  });

  it('ignores a duplicated id rather than cancelling the message out', async () => {
    // XOR is not idempotent: folding a message in twice would erase it from the key entirely, and
    // a store holding a duplicate would then agree with a peer that is genuinely missing it.
    expect(await historyStateKey([msg('m1'), msg('m1')])).toBe(await historyStateKey([msg('m1')]));
  });

  it('reads a user id case-insensitively, the way every other identity here is compared', async () => {
    const upper = msg('m1', { reactions: [{ emoji: '👍', userId: 'USER-B', at: 10 }] });
    const lower = msg('m1', { reactions: [{ emoji: '👍', userId: 'user-b', at: 10 }] });
    expect(await historyStateKey([upper])).toBe(await historyStateKey([lower]));
  });

  it('answers an empty selection with a key of its own', async () => {
    // "I hold nothing in this window" is an answer, and a peer holding nothing either must match it.
    const empty = await historyStateKey([]);
    expect(empty).toMatch(/^[0-9a-f]{16}$/);
    expect(await historyStateKey([])).toBe(empty);
  });
});

describe('historyStateKey - what it must notice', () => {
  const base = [msg('m1'), msg('m2')];

  async function differsFromBase(messages: StoredMessage[]): Promise<boolean> {
    return (await historyStateKey(messages)) !== (await historyStateKey(base));
  }

  it('notices a missing message', async () => {
    expect(await differsFromBase([msg('m1')])).toBe(true);
  });

  it('notices an extra message', async () => {
    expect(await differsFromBase([...base, msg('m3')])).toBe(true);
  });

  it('notices a deletion - the case ids alone would miss', async () => {
    // Two devices agreeing that a message EXISTS can still disagree about whether it was deleted,
    // and with a key over ids alone both would call themselves complete.
    expect(await differsFromBase([msg('m1', { isDeleted: true }), msg('m2')])).toBe(true);
  });

  it('notices an edit, and tells two different edits of the same message apart', async () => {
    const first = [msg('m1', { isEdited: true, editedAt: 10 }), msg('m2')];
    const second = [msg('m1', { isEdited: true, editedAt: 20 }), msg('m2')];
    expect(await differsFromBase(first)).toBe(true);
    expect(await historyStateKey(first)).not.toBe(await historyStateKey(second));
  });

  it('notices a reaction, and notices it being taken back', async () => {
    const placed = [
      msg('m1', { reactions: [{ emoji: '👍', userId: 'user-b', at: 10 }] }),
      msg('m2'),
    ];
    const removed = [
      msg('m1', { reactions: [{ emoji: '👍', userId: 'user-b', at: 20, removed: true }] }),
      msg('m2'),
    ];
    expect(await differsFromBase(placed)).toBe(true);
    expect(await historyStateKey(placed)).not.toBe(await historyStateKey(removed));
  });

  it('notices a reaction re-placed later, since the pair carries its own instant', async () => {
    const early = [msg('m1', { reactions: [{ emoji: '👍', userId: 'user-b', at: 10 }] })];
    const late = [msg('m1', { reactions: [{ emoji: '👍', userId: 'user-b', at: 30 }] })];
    expect(await historyStateKey(early)).not.toBe(await historyStateKey(late));
  });
});

describe('historyStateKey - what it must NOT notice', () => {
  it('ignores the content, so a purged deletion still matches a peer that purged it too', async () => {
    // A deleted message keeps its id and loses its text. Hashing content would make the purge itself
    // look like a difference, permanently, between two devices that agree completely.
    const ours = msg('m1', { isDeleted: true, content: '' });
    const theirs = msg('m1', { isDeleted: true, content: 'residue an older build left behind' });
    expect(await historyStateKey([ours])).toBe(await historyStateKey([theirs]));
  });

  it('ignores the sender and the timestamp, which no exchange can repair', async () => {
    // A stored timestamp can differ by a hair between two devices; making the key depend on it
    // would put every conversation permanently out of agreement for a difference nothing repairs.
    const ours = msg('m1', { senderId: 'user-a', timestamp: T });
    const theirs = msg('m1', { senderId: 'user-b', timestamp: T + 1 });
    expect(await historyStateKey([ours])).toBe(await historyStateKey([theirs]));
  });
});

describe('historyStateKey - the window', () => {
  const OLD = 1_600_000_000_000;
  const SINCE = 1_650_000_000_000;

  it('covers only what falls at or after the stated instant', async () => {
    const withOld = [msg('old', { timestamp: OLD }), msg('new', { timestamp: T })];
    expect(await historyStateKey(withOld, SINCE)).toBe(
      await historyStateKey([msg('new', { timestamp: T })], SINCE)
    );
  });

  it('includes the boundary itself', async () => {
    const atBoundary = [msg('m1', { timestamp: SINCE })];
    expect(await historyStateKey(atBoundary, SINCE)).not.toBe(await historyStateKey([], SINCE));
  });

  it('covers everything when no window is stated', async () => {
    const all = [msg('old', { timestamp: OLD }), msg('new', { timestamp: T })];
    expect(await historyStateKey(all)).not.toBe(await historyStateKey(all, SINCE));
  });

  it('keeps a message whose timestamp cannot be compared', async () => {
    // An unusable date is not evidence that a message is old, and dropping it would make the key
    // claim an agreement about a message it silently excluded.
    const undated = [msg('m1', { timestamp: undefined as unknown as number })];
    expect(await historyStateKey(undated, SINCE)).not.toBe(await historyStateKey([], SINCE));
  });
});

describe('canonicalMessageState', () => {
  it('gives an unedited message no edit time at all', async () => {
    // The flag and the time travel together; a message that was never edited must not look like one
    // edited at the epoch.
    expect(canonicalMessageState(msg('m1'))).toBe(canonicalMessageState(msg('m1', {})));
    expect(canonicalMessageState(msg('m1'))).not.toContain('undefined');
  });

  it('gives an edit with no recorded time a state of its own', async () => {
    // A client too old to send the time contributes its flag and no time, which is what it knows -
    // and that must not read as "not edited".
    expect(canonicalMessageState(msg('m1', { isEdited: true }))).not.toBe(
      canonicalMessageState(msg('m1'))
    );
  });

  it('defaults an undated reaction rather than leaving it undefined', async () => {
    const bare = canonicalMessageState(msg('m1', { reactions: [{ emoji: '👍', userId: 'u' }] }));
    expect(bare).not.toContain('undefined');
    expect(bare).toBe(
      canonicalMessageState(msg('m1', { reactions: [{ emoji: '👍', userId: 'u', at: 0 }] }))
    );
  });
});

describe('parseHistoryStateKey', () => {
  it('accepts a well-formed key and normalises its case', () => {
    expect(parseHistoryStateKey('ABCDEF0123456789')).toBe('abcdef0123456789');
  });

  it('rejects everything that is not one', () => {
    for (const raw of [undefined, null, 42, {}, '', 'zz', 'abcdef012345678', 'abcdef01234567890']) {
      expect(parseHistoryStateKey(raw)).toBeNull();
    }
  });
});
