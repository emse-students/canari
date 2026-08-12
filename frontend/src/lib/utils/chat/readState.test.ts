import type { ChatMessage, ReadWatermarks } from '$lib/types';
import {
  countUnreadForUser,
  hasRead,
  isUnreadForUser,
  mergeReadWatermark,
  mergeReadWatermarks,
  readersOf,
  watermarkAfterReading,
  watermarkFor,
} from './readState';

/**
 * Read state as a watermark. The properties worth asserting are the ones that make it a CRDT -
 * `max` is commutative, associative and idempotent - plus the two things the old per-message
 * `readBy` array could not do: cover a message the device does not hold yet, and cost one write
 * instead of one per message.
 */

const ME = 'me';
const PEER = 'peer';

function msg(
  id: string,
  at: number,
  senderId = PEER,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    senderId,
    content: 'hello',
    timestamp: new Date(at),
    isOwn: senderId === ME,
    ...extra,
  };
}

describe('advancing a watermark', () => {
  it('takes the later instant', () => {
    expect(mergeReadWatermark({ [PEER]: 1000 }, PEER, 2000)).toEqual({ [PEER]: 2000 });
  });

  it('refuses to go backwards, whichever order the two arrive in', () => {
    expect(mergeReadWatermark({ [PEER]: 2000 }, PEER, 1000)).toBeNull();
  });

  it('reports no change for the same value, so nothing re-renders on a repeat', () => {
    expect(mergeReadWatermark({ [PEER]: 2000 }, PEER, 2000)).toBeNull();
  });

  it('normalises the user id, so a case difference is not a second participant', () => {
    expect(mergeReadWatermark({}, 'Peer', 2000)).toEqual({ [PEER]: 2000 });
    expect(mergeReadWatermark({ [PEER]: 2000 }, 'PEER', 1000)).toBeNull();
  });

  it('ignores a value that is not a usable instant', () => {
    expect(mergeReadWatermark({}, PEER, 0)).toBeNull();
    expect(mergeReadWatermark({}, PEER, Number.NaN)).toBeNull();
    expect(mergeReadWatermark({}, '', 2000)).toBeNull();
  });

  it('leaves the other participants alone', () => {
    expect(mergeReadWatermark({ [ME]: 500 }, PEER, 2000)).toEqual({ [ME]: 500, [PEER]: 2000 });
  });
});

describe('merging two whole maps', () => {
  it('takes the later instant per participant', () => {
    expect(mergeReadWatermarks({ [ME]: 500, [PEER]: 3000 }, { [ME]: 1500, [PEER]: 1000 })).toEqual({
      [ME]: 1500,
      [PEER]: 3000,
    });
  });

  it('reports no change when the incoming map adds nothing', () => {
    expect(mergeReadWatermarks({ [ME]: 500 }, { [ME]: 400 })).toBeNull();
    expect(mergeReadWatermarks({ [ME]: 500 }, {})).toBeNull();
    expect(mergeReadWatermarks({ [ME]: 500 }, undefined)).toBeNull();
  });

  it('converges to the same map whatever order the updates arrive in', () => {
    // The whole point of `max`: three devices exchanging read state in any order end up equal.
    const updates: ReadWatermarks[] = [
      { [ME]: 700 },
      { [PEER]: 2000 },
      { [ME]: 300, [PEER]: 4000 },
    ];
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [2, 0, 1],
    ];
    const results = orders.map((order) => {
      let acc: ReadWatermarks = {};
      for (const i of order) acc = mergeReadWatermarks(acc, updates[i]) ?? acc;
      return acc;
    });

    for (const result of results) expect(result).toEqual({ [ME]: 700, [PEER]: 4000 });
  });

  it('is idempotent - applying the same map twice changes nothing', () => {
    const once = mergeReadWatermarks({}, { [PEER]: 2000 })!;
    expect(mergeReadWatermarks(once, { [PEER]: 2000 })).toBeNull();
  });
});

describe('who has read a message', () => {
  it('covers a message the watermark is at or past', () => {
    expect(hasRead({ [PEER]: 2000 }, PEER, msg('a', 2000))).toBe(true);
    expect(hasRead({ [PEER]: 2000 }, PEER, msg('a', 1999))).toBe(true);
    expect(hasRead({ [PEER]: 2000 }, PEER, msg('a', 2001))).toBe(false);
  });

  it('covers a message that arrived AFTER the receipt was sent', () => {
    // The defect the watermark exists to remove: a history catch-up delivering an older message
    // used to mark it unread, because a `readBy` entry can only be written on a device that holds
    // the message, and this one was not there when the receipt went out.
    const late = msg('older', 1500);

    expect(hasRead({ [PEER]: 2000 }, PEER, late)).toBe(true);
  });

  it('says no for a participant who has sent nothing', () => {
    expect(hasRead({ [PEER]: 2000 }, 'stranger', msg('a', 1000))).toBe(false);
    expect(watermarkFor(undefined, PEER)).toBe(0);
  });
});

describe('the readers shown on a message', () => {
  it('lists everyone past it, sorted, and never its own author', () => {
    const watermarks = { [ME]: 5000, [PEER]: 5000, zoe: 5000 };

    expect(readersOf(msg('a', 1000, ME), watermarks)).toEqual([PEER, 'zoe']);
  });

  it('leaves out anyone whose watermark is behind it', () => {
    expect(readersOf(msg('a', 3000, ME), { [PEER]: 2000, zoe: 4000 })).toEqual(['zoe']);
  });

  it('is empty when nobody has read anything', () => {
    expect(readersOf(msg('a', 1000, ME), undefined)).toEqual([]);
    expect(readersOf(msg('a', 1000, ME), {})).toEqual([]);
  });
});

describe('the unread badge', () => {
  it('counts what is past the watermark, and nothing of our own', () => {
    const messages = [msg('a', 1000), msg('b', 2000), msg('c', 3000), msg('d', 4000, ME)];

    expect(countUnreadForUser(messages, 2000)).toBe(1);
    expect(countUnreadForUser(messages, 0)).toBe(3);
    expect(countUnreadForUser(messages, 9000)).toBe(0);
  });

  it('never counts a system message', () => {
    expect(isUnreadForUser(msg('a', 5000, 'system'), 0)).toBe(false);
    expect(isUnreadForUser(msg('a', 5000, PEER, { isSystem: true }), 0)).toBe(false);
  });
});

describe('the watermark reading a conversation produces', () => {
  it('is the latest instant on screen, our own messages included', () => {
    const messages = [msg('a', 1000), msg('b', 4000, ME), msg('c', 2000)];

    expect(watermarkAfterReading(messages, 0)).toBe(4000);
  });

  it('never moves backwards', () => {
    expect(watermarkAfterReading([msg('a', 1000)], 5000)).toBe(5000);
    expect(watermarkAfterReading([], 5000)).toBe(5000);
  });

  it('is drawn from the messages, not the clock', () => {
    // A device whose clock runs an hour fast would otherwise mark an hour of unread messages read,
    // for everyone, permanently - the merge being `max`, nothing can ever take it back.
    const messages = [msg('a', 1000), msg('b', 2000)];

    expect(watermarkAfterReading(messages, 0)).toBe(2000);
    expect(watermarkAfterReading(messages, 0)).toBeLessThan(Date.now());
  });

  it('skips a system message, which nobody reads', () => {
    const messages = [msg('a', 1000), msg('sys', 9000, 'system')];

    expect(watermarkAfterReading(messages, 0)).toBe(1000);
  });
});
