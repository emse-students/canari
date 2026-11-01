import type { ChatMessage, ReadWatermarks } from '$lib/types';
import { compareMessageOrder } from './messageOrder';
import {
  countUnreadBelow,
  countUnreadForUser,
  hasRead,
  isUnreadForUser,
  mergeReadWatermark,
  mergeReadWatermarks,
  readMarkTarget,
  serverMarkCeiling,
  readWatermarkFrameData,
  readWatermarkFrameMark,
  readersOf,
  seenByAnchors,
  watermarkAfterReading,
  watermarkFor,
  withOwnReadAdvanced,
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

  it('COUNTS UP AS HISTORY LOADS when nothing ever advances the watermark', () => {
    // Not a property worth having - a property worth REFUSING, and the reason a conversation kind
    // may never be excused from the local watermark write. Community channels were: the guard that
    // (correctly) keeps their read receipt off the MLS outbox sat at the top of the effect and
    // skipped the local write with it, so every salon stayed at 0. The badge then meant "every
    // message this device holds that is not mine", and scrolling up - the one gesture that loads
    // more of them - made it climb. Reported from a community thread on 2026-09-09.
    const onScreen = [msg('c', 3000), msg('d', 4000)];
    const afterScrollingUp = [msg('a', 1000), msg('b', 2000), ...onScreen];

    expect(countUnreadForUser(onScreen, 0)).toBe(2);
    expect(countUnreadForUser(afterScrollingUp, 0)).toBe(4);

    // With the watermark written, the same gesture loads older messages the reader is BEHIND, and
    // the count does not move. That is the invariant the badge is drawn from.
    const read = watermarkAfterReading(onScreen, 0);
    expect(countUnreadForUser(onScreen, read)).toBe(0);
    expect(countUnreadForUser(afterScrollingUp, read)).toBe(0);
  });
});

describe('the unread count of the scroll-to-bottom button', () => {
  const thread = [
    msg('a', 1000),
    msg('b', 2000, ME),
    msg('c', 3000),
    msg('d', 4000, ME),
    msg('e', 5000),
  ];
  const at = (rows: ChatMessage[], id: string) => ({
    id,
    index: rows.findIndex((m) => m.id === id),
  });

  it('counts only the unread rows AFTER the last visible one', () => {
    // Watermark 0: a, c, e are unread. Viewing up to c, only e lies below.
    expect(countUnreadBelow(thread, at(thread, 'c'), 0)).toBe(1);
    expect(countUnreadBelow(thread, at(thread, 'a'), 0)).toBe(2);
  });

  it('shows nothing for an unread row above or in view, the owner report of 2026-11-01', () => {
    expect(countUnreadBelow(thread, at(thread, 'e'), 0)).toBe(0);
    expect(countUnreadBelow(thread, at(thread, 'c'), 5000)).toBe(0);
    const own = [msg('a', 1000), msg('b', 2000, ME)];
    expect(countUnreadBelow(own, at(own, 'a'), 0)).toBe(0);
  });

  it('counts nothing while the position is unmeasured', () => {
    expect(countUnreadBelow(thread, null, 0)).toBe(0);
  });

  it('follows DISPLAY order, not the order the store holds the rows in', () => {
    // The store holds e before c; the thread draws c then e. Viewing c, e is below it.
    const store = [thread[0], thread[4], thread[2]];
    const display = [thread[0], thread[2], thread[4]];
    expect(countUnreadBelow(display, at(display, 'c'), 0)).toBe(1);
    expect(countUnreadBelow(store, at(store, 'c'), 0)).toBe(0);
  });

  it('never counts a derived system or roster line below the viewport', () => {
    const roster = msg('r', 9000, 'system', { isSystem: true });
    const roster2 = msg('r2', 9500, PEER, { isSystem: true });
    expect(countUnreadBelow([...thread, roster, roster2], at(thread, 'e'), 0)).toBe(0);
    expect(countUnreadBelow([...thread, roster, roster2], at(thread, 'c'), 0)).toBe(1);
  });

  it('counts a new incoming row that lands below the viewport', () => {
    expect(countUnreadBelow([...thread, msg('f', 6000)], at(thread, 'e'), 0)).toBe(1);
  });

  it('after the list changes, a vanished anchor resolves to the nearest surviving row', () => {
    // Viewing d (index 3); d is deleted. The row now at index 3 (e) stands in: nothing below it.
    const withoutD = thread.filter((m) => m.id !== 'd');
    expect(countUnreadBelow(withoutD, { id: 'd', index: 3 }, 0)).toBe(0);
    // An anchor past the end of a shortened list clamps to the last row.
    expect(countUnreadBelow(thread.slice(0, 3), { id: 'gone', index: 4 }, 0)).toBe(0);
    // The anchor's row moved (rows prepended): found by id, not by its stale index.
    const prepended = [msg('z', 500), ...thread];
    expect(countUnreadBelow(prepended, { id: 'c', index: 2 }, 0)).toBe(1);
  });
});

describe('the watermark reading a conversation produces', () => {
  it('is the latest instant on screen, our own messages included', () => {
    const messages = [msg('a', 1000), msg('b', 4000, ME), msg('c', 2000)];

    expect(watermarkAfterReading(messages, 0)).toBe(4000);
  });

  it('a salon echo awaiting its server row does not move the read point (WP-OFF-2)', () => {
    // The echo is dated by the author's clock, 900 ms ahead of the server here; a mark taken from it
    // would read as "read" a message the server stamps inside that lead.
    const echo = msg('local-uuid', 5900, ME, { awaitingServerId: true });
    expect(watermarkAfterReading([msg('a', 5000), echo], 0, true)).toBe(5000);

    const settled = msg('srv-1', 5001, ME);
    expect(watermarkAfterReading([msg('a', 5000), settled], 0, true)).toBe(5001);
  });

  it('a salon read point reaches a trailing membership notice, a DM one does not', () => {
    // Prod 2026-10-11: a salon whose newest rows were two "X added Y" notices could never be marked
    // read, because the notices were skipped - the server kept counting them at every reload.
    const messages = [msg('a', 1000, PEER), msg('sys', 2000, 'system', { isSystem: true })];

    expect(watermarkAfterReading(messages, 1000)).toBe(1000);
    expect(watermarkAfterReading(messages, 1000, true)).toBe(2000);
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

describe('where each head sits in a group (seen by)', () => {
  const ALICE = 'alice';
  const BOB = 'bob';

  it('puts a head under the last message its owner read, whoever wrote it', () => {
    const messages = [msg('a', 1000, ME), msg('b', 2000, PEER), msg('c', 3000, PEER)];
    const anchors = seenByAnchors(messages, { [ALICE]: 2000, [BOB]: 3000 }, ME);

    expect(anchors.get('b')).toEqual([ALICE]);
    expect(anchors.get('c')).toEqual([BOB]);
    expect(anchors.has('a')).toBe(false);
  });

  it('places every reader where a scan from the end would, by search (review of #2824, P3-7)', () => {
    // Dated rows whose sentAt runs out of order (clocks skew both ways), an unsent own row below
    // them all, and readers on either clock: the display order is monotone in neither key.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const writers = [PEER, ALICE, BOB, 'carol'];
    const rows: ChatMessage[] = Array.from({ length: 300 }, (_, i) =>
      dated(
        `m-${i}`,
        10_000 + i * 100 + Math.round((next() - 0.5) * 5_000),
        10_000 + i * 100,
        writers[Math.floor(next() * writers.length)]
      )
    );
    rows.push(msg('unsent', 12_000, ME, { status: 'pending' }));
    rows.sort(compareMessageOrder);
    const stamped: ReadWatermarks = {};
    const server: ReadWatermarks = {};
    for (let r = 0; r < 40; r++) {
      const reader = `reader-${r}`;
      if (next() < 0.7) stamped[reader] = 9_000 + Math.round(next() * 32_000);
      if (next() < 0.7) server[reader] = 9_000 + Math.round(next() * 32_000);
    }
    stamped[ALICE] = 20_000;
    server[BOB] = 15_000;

    const reference = new Map<string, string[]>();
    const all = new Set([...Object.keys(stamped), ...Object.keys(server)]);
    for (const reader of all) {
      let found = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const serverKey = row.serverTimestamp ?? row.timestamp.getTime();
        const covered =
          ((server[reader] ?? 0) > 0 && (server[reader] ?? 0) >= serverKey) ||
          (stamped[reader] ?? 0) >= row.timestamp.getTime();
        if (row.senderId === reader || covered) {
          found = i;
          break;
        }
      }
      if (found < 0 || rows[found].senderId === reader) continue;
      reference.set(rows[found].id, [...(reference.get(rows[found].id) ?? []), reader].sort());
    }

    expect(seenByAnchors(rows, stamped, ME, server)).toEqual(reference);
  });

  it('never draws the viewer', () => {
    const anchors = seenByAnchors([msg('a', 1000, PEER)], { [ME]: 1000 }, 'ME');

    expect(anchors.size).toBe(0);
  });

  it('gathers every head anchored on one message, sorted', () => {
    const anchors = seenByAnchors(
      [msg('a', 1000, ME)],
      { [BOB]: 1000, [ALICE]: 1500, d: 1000, e: 1000 },
      ME
    );

    expect(anchors.get('a')).toEqual([ALICE, BOB, 'd', 'e']);
  });

  it('counts an author as having read their own message, and draws no head on it', () => {
    // Alice replied at 3000 while her watermark still says 1000: she has obviously seen her reply,
    // so her head must not sit ABOVE it - and on her own message it says nothing.
    const messages = [msg('a', 1000, ME), msg('b', 3000, ALICE)];
    const anchors = seenByAnchors(messages, { [ALICE]: 1000 }, ME);

    expect(anchors.size).toBe(0);
  });

  it('skips system notices', () => {
    const messages = [msg('a', 1000, PEER), msg('sys', 2000, 'system', { isSystem: true })];
    const anchors = seenByAnchors(messages, { [ALICE]: 5000 }, ME);

    expect(anchors.get('a')).toEqual([ALICE]);
  });

  it('anchors a reader whose last read message is NEWER than the list on its newest row', () => {
    // Bob's watermark is past everything loaded: he has read every row this device holds.
    const messages = [msg('a', 1000, PEER), msg('b', 2000, ALICE)];
    const anchors = seenByAnchors(messages, { [BOB]: 9000 }, ME);

    expect(anchors.get('b')).toEqual([BOB]);
  });

  it('draws no head for a reader whose last read message is OLDER than the loaded page', () => {
    // History paged in from 5000: Bob stopped at a message this device has not loaded, and every
    // loaded row is one he has NOT read - a head anywhere would claim otherwise.
    const messages = [msg('a', 5000, PEER), msg('b', 6000, ALICE)];
    const anchors = seenByAnchors(messages, { [BOB]: 3000 }, ME);

    expect(anchors.size).toBe(0);
  });

  it('draws only who the watermarks hold - a member absent from them never appears', () => {
    // The map IS the visibility predicate (a salon's read-marks are restricted server-side to who
    // may read it now); a member who wrote a message but holds no mark gets no head anywhere.
    const messages = [msg('a', 1000, BOB), msg('b', 2000, PEER)];
    const anchors = seenByAnchors(messages, { [ALICE]: 2000 }, ME);

    expect([...anchors.values()].flat()).toEqual([ALICE]);
  });

  it('never puts a head under a message its owner has not reached', () => {
    const messages = [msg('a', 1000), msg('b', 2000), msg('c', 3000)];
    const anchors = seenByAnchors(messages, { [ALICE]: 2999 }, ME);

    expect(anchors.get('b')).toEqual([ALICE]);
    expect(anchors.has('c')).toBe(false);
  });

  it('draws nobody who has read nothing on the list', () => {
    expect(seenByAnchors([msg('a', 5000, PEER)], { [ALICE]: 1000 }, ME).size).toBe(0);
    expect(seenByAnchors([msg('a', 5000, PEER)], undefined, ME).size).toBe(0);
  });
});

describe('withOwnReadAdvanced - the count follows my own read point', () => {
  const held = (
    id: string,
    at: number
  ): Pick<ChatMessage, 'isOwn' | 'isSystem' | 'senderId' | 'timestamp'> & { id: string } => ({
    id,
    isOwn: false,
    isSystem: false,
    senderId: 'peer',
    timestamp: new Date(at),
  });
  const convo = (unreadCount: number, readWatermarks?: ReadWatermarks) => ({
    messages: [held('a', 1000), held('b', 2000), held('c', 3000)],
    unreadCount,
    readWatermarks,
  });

  it('clears the count when the watermark passes every held message', () => {
    const next = withOwnReadAdvanced(convo(3), 'Me', 3000, 'stamped');
    expect(next.unreadCount).toBe(0);
    expect(next.readWatermarks).toEqual({ me: 3000 });
  });

  it('keeps a message newer than what was read counted - never an unconditional zero', () => {
    expect(withOwnReadAdvanced(convo(3), 'me', 2000, 'stamped').unreadCount).toBe(1);
  });

  it('never raises a count, whatever the held messages say', () => {
    expect(withOwnReadAdvanced(convo(1), 'me', 500, 'stamped').unreadCount).toBe(1);
  });

  it('clears a stale count even when the watermark was already there', () => {
    const next = withOwnReadAdvanced(convo(2, { me: 3000 }), 'me', 3000, 'stamped');
    expect(next.unreadCount).toBe(0);
  });

  it('returns the same object when nothing moves, so a repeat costs no re-render', () => {
    const c = convo(0, { me: 3000 });
    expect(withOwnReadAdvanced(c, 'me', 3000, 'stamped')).toBe(c);
  });
});

/** A server statement far in the future: the ceiling's own bound is out of the way. */
const SEEN = Number.MAX_SAFE_INTEGER;

describe('readMarkTarget - the sender says only what is new', () => {
  it("does not move a DM mark over the reader's own send, so sending emits no watermark", () => {
    // Read the peer up to 2000, then reply at 3000: before this rule the mark became 3000 and a
    // frame went out 2 s later carrying nothing a receiver did not already know.
    const msgs = [msg('a', 1000), msg('b', 2000), msg('mine', 3000, ME)];
    expect(readMarkTarget(msgs, 2000, false, SEEN)).toBe(2000);
    expect(watermarkAfterReading(msgs, 2000)).toBe(3000);
  });

  it("still moves a DM mark over a foreign message that arrives after the reader's own", () => {
    const msgs = [dated('mine', 3000, 3000, ME), dated('late', 2500, 2500)];
    expect(readMarkTarget(msgs, 2000, false, SEEN)).toBe(2500);
  });

  it('counts unread exactly as before: an own message never was unread', () => {
    const msgs = [dated('a', 1000, 1000), dated('mine', 3000, 3000, ME)];
    expect(countUnreadForUser(msgs, 0, readMarkTarget(msgs, 0, false, SEEN))).toBe(0);
  });

  it('leaves a salon unchanged - own and system rows still move its server mark (#1619, #1820)', () => {
    const msgs = [
      msg('a', 1000),
      msg('mine', 3000, ME),
      msg('notice', 4000, 'system', { isSystem: true }),
    ];
    expect(readMarkTarget(msgs, 0, true, SEEN)).toBe(watermarkAfterReading(msgs, 0, true));
    expect(readMarkTarget(msgs, 0, true, SEEN)).toBe(4000);
  });
});

/**
 * THE SERVER'S CLOCK (owner, 2026-10-31). A DM or group is ordered by the time the server accepted
 * each message, and a mark this build takes is on that clock, in its own map. The stamped map - every
 * mark before the change, an older client's frame, the native shade - is kept and still counts.
 */
/** A message stamped `sentAt` by its author and accepted by the server at `serverAt`. */
const dated = (id: string, sentAt: number, serverAt: number, senderId = PEER) =>
  msg(id, sentAt, senderId, { serverTimestamp: serverAt });

/** The read state a conversation carries, as `withOwnReadAdvanced` reads and writes it. */
type HeldConvo = {
  messages: ChatMessage[];
  readWatermarks?: ReadWatermarks;
  serverReadWatermarks?: ReadWatermarks;
  unreadCount: number;
};

/**
 * THE CEILING (review of #2824, 2026-11-01). A DM or group mark is the newest key read, and a key
 * falls back on the AUTHOR's clock for an undated row while a bundle row's server time was written by
 * its relayer: unbounded, one row dated 2100 would mark every later message read, for good.
 */
describe('readMarkTarget - bounded by the server times held and seen', () => {
  it('a row claiming 2100 moves no mark past the newest server time held', () => {
    const y2100 = Date.UTC(2100, 0, 1);
    const msgs = [dated('a', 1000, 1_500), msg('forged', y2100)];
    expect(readMarkTarget(msgs, 0, false, SEEN)).toBe(1_500);
  });

  it('never above what the server said on this device, even over a held time', () => {
    const msgs = [dated('a', 1000, 1_500), dated('relayed', 1000, 9_000)];
    expect(readMarkTarget(msgs, 0, false, 2_000)).toBe(2_000);
    expect(serverMarkCeiling(msgs, SEEN)).toBe(9_000);
  });

  it('moves NOTHING while the server has said nothing on this device, dated rows or not', () => {
    // An offline first boot: the rows held are the only bound, and they are what is not trusted.
    const msgs = [dated('a', 1000, 1_500), dated('b', 2000, 2_500)];
    expect(serverMarkCeiling(msgs, 0)).toBe(0);
    expect(readMarkTarget(msgs, 700, false, 0)).toBe(700);
  });

  it('a session whose only statement is OLD moves the mark no further than that statement', () => {
    const msgs = [dated('a', 1000, 1_500), dated('b', 2000, 9_000)];
    expect(readMarkTarget(msgs, 0, false, 1_200)).toBe(1_200);
    expect(readMarkTarget(msgs, 1_300, false, 1_200)).toBe(1_300);
  });

  it('a conversation with no dated row moves only once the server has said something', () => {
    const msgs = [msg('a', 1000), msg('b', 2000)];
    expect(readMarkTarget(msgs, 0, false, 0)).toBe(0);
    expect(readMarkTarget(msgs, 0, false, 5_000)).toBe(2000);
  });
});

describe('read marks on the server clock', () => {
  it('a LATE message - written before the mark, accepted after it - is unread and notifies', () => {
    // Read up to the server's 10 000. The late message was composed at 5 000 (author's clock) and
    // the server took it at 12 000: by the author's clock it is "already read", by the server's not.
    const late = dated('late', 5_000, 12_000);
    expect(isUnreadForUser(late, 0, 10_000)).toBe(true);
    expect(hasRead(undefined, ME, late, { [ME]: 10_000 })).toBe(false);
    // The stamped clock alone would have called it read - the defect this change ends.
    expect(isUnreadForUser(late, 10_000, 0)).toBe(false);
  });

  it('keeps read what a stamped mark from before the change covered, so nothing comes back unread', () => {
    // Stored stamped mark 5 000 = the sentAt of the last message read. Its server time is later.
    const old = dated('old', 5_000, 5_400);
    expect(isUnreadForUser(old, 5_000, 0)).toBe(false);
    expect(countUnreadForUser([old], 5_000, 0)).toBe(0);
  });

  it('withOwnReadAdvanced on the server clock writes the server map and counts by both', () => {
    const convo: HeldConvo = {
      messages: [dated('a', 1_000, 1_100), dated('late', 900, 3_000)],
      readWatermarks: { [ME]: 1_000 },
      unreadCount: 1,
    };
    const next = withOwnReadAdvanced(convo, ME, 3_000, 'server');
    expect(next.serverReadWatermarks).toEqual({ [ME]: 3_000 });
    expect(next.readWatermarks).toEqual({ [ME]: 1_000 });
    expect(next.unreadCount).toBe(0);
  });

  it('readMarkTarget answers on the server clock', () => {
    const msgs = [dated('a', 1_000, 1_100), dated('late', 900, 3_000)];
    expect(readMarkTarget(msgs, 0, false, SEEN)).toBe(3_000);
  });

  it('places a reader by whichever of their two marks reaches further', () => {
    const ALICE = 'alice';
    // Display order is the server's: b (2 000), then late (5 000, written at 1 500).
    const messages = [dated('b', 2_000, 2_000), dated('late', 1_500, 5_000)];
    // An OLDER client: its stamped mark 2 000 covers `late` by its sentAt, and nothing newer says
    // otherwise for it - the residue legacy-compatibility.md names.
    expect(seenByAnchors(messages, { [ALICE]: 2_000 }, ME).get('late')).toEqual([ALICE]);
    // A client on this build read up to the server's 2 000: `late` arrived after, so not read.
    expect(seenByAnchors(messages, undefined, ME, { [ALICE]: 2_000 }).get('b')).toEqual([ALICE]);
    expect(readersOf(messages[1], undefined, { [ALICE]: 2_000 })).toEqual([]);
  });
});

describe('the read_watermark frame, old and new', () => {
  it('this build says the mark twice: `serverAt` for itself, `at` for an older client', () => {
    expect(readWatermarkFrameData(7_000)).toEqual({ at: 7_000, serverAt: 7_000 });
  });

  it('reads `serverAt` as the server clock and a bare `at` as the stamped one', () => {
    expect(readWatermarkFrameMark({ at: 7_000, serverAt: 7_000 })).toEqual({
      at: 7_000,
      clock: 'server',
    });
    expect(readWatermarkFrameMark({ at: 6_000 })).toEqual({ at: 6_000, clock: 'stamped' });
    expect(readWatermarkFrameMark({ at: 'x' })).toBeNull();
    expect(readWatermarkFrameMark({})).toBeNull();
  });

  it('mixed frames from one reader land in their own maps and both count', () => {
    // An older device of the reader says at=4 000 (stamped), a newer one serverAt=3 000.
    const old = readWatermarkFrameMark({ at: 4_000 })!;
    const fresh = readWatermarkFrameMark({ at: 3_000, serverAt: 3_000 })!;
    let convo: HeldConvo = { messages: [], unreadCount: 0 };
    convo = withOwnReadAdvanced(convo, PEER, old.at, old.clock);
    convo = withOwnReadAdvanced(convo, PEER, fresh.at, fresh.clock);
    expect(convo).toMatchObject({
      readWatermarks: { [PEER]: 4_000 },
      serverReadWatermarks: { [PEER]: 3_000 },
    });
    // Written at 3 500 and accepted at 3 600: read by the older device's mark, which says so.
    const m = dated('m', 3_500, 3_600, ME);
    expect(hasRead(convo.readWatermarks, PEER, m, convo.serverReadWatermarks)).toBe(true);
    // Written at 4 500, accepted at 4 600: neither covers it.
    const n = dated('n', 4_500, 4_600, ME);
    expect(hasRead(convo.readWatermarks, PEER, n, convo.serverReadWatermarks)).toBe(false);
  });
});
