// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '$lib/types';
import { flushSalonReadMarks, recordSalonReadMark } from './salonReadMarkQueue';
import {
  beginUnreadReconcile,
  clearSalonUnreadLocally,
  isSalonMuted,
  noteSalonNotificationLevel,
  communityUnreadUpTo,
  noteSalonOpened,
  parseSalonUnreadAnswer,
  reconcileSalonUnread,
  reconcileSalonUnreadFromServer,
  resetSalonUnread,
} from './salonUnread';

const ME = 'me';
const SALON = 'channel_aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'channel_aaaaaaaa-0000-0000-0000-000000000002';

function convo(over: Partial<Conversation> = {}): Conversation {
  return { id: SALON, messages: [], unreadCount: 0, ...over } as unknown as Conversation;
}

function msg(id: string, serverTimestamp: number, over: Record<string, unknown> = {}) {
  return {
    id,
    senderId: 'someone',
    content: 'x',
    timestamp: new Date(serverTimestamp),
    serverTimestamp,
    isOwn: false,
    isSystem: false,
    ...over,
  };
}

/**
 * The unread count of a salon after a reload (2026-10-08). The live tally is empty after any
 * reload, so a salon with three unread messages drew nothing while the server's read mark said
 * otherwise; the server now counts and this merges its answer with what arrived live since.
 */
describe('reconcileSalonUnread', () => {
  beforeEach(() => resetSalonUnread());

  it('takes the server count for a salon this device never heard about', () => {
    const map = new Map([[SALON, convo()]]);
    const token = beginUnreadReconcile();
    const changed = reconcileSalonUnread(
      map,
      { asOf: 1000, counts: { 'aaaaaaaa-0000-0000-0000-000000000001': 3 } },
      null,
      ME,
      token
    );
    expect(changed).toEqual([SALON]);
    expect(map.get(SALON)?.unreadCount).toBe(3);
  });

  it('adds only what landed live AFTER the server counted, never what it already counted', () => {
    const map = new Map([[SALON, convo({ messages: [msg('a', 900), msg('b', 1100)] as never })]]);
    reconcileSalonUnread(
      map,
      { asOf: 1000, counts: { 'aaaaaaaa-0000-0000-0000-000000000001': 2 } },
      null,
      ME,
      beginUnreadReconcile()
    );
    // 2 counted by the server (a is among them) + b, which arrived after it counted.
    expect(map.get(SALON)?.unreadCount).toBe(3);
  });

  it('does not count own or system messages that arrived after the server counted', () => {
    const map = new Map([
      [
        SALON,
        convo({
          messages: [msg('o', 1100, { isOwn: true }), msg('s', 1200, { isSystem: true })] as never,
        }),
      ],
    ]);
    reconcileSalonUnread(map, { asOf: 1000, counts: {} }, null, ME, beginUnreadReconcile());
    expect(map.get(SALON)?.unreadCount).toBe(0);
  });

  it('lowers a count the server says is read - another device read it', () => {
    const map = new Map([[SALON, convo({ unreadCount: 4 })]]);
    reconcileSalonUnread(map, { asOf: 1000, counts: {} }, null, ME, beginUnreadReconcile());
    expect(map.get(SALON)?.unreadCount).toBe(0);
  });

  it('leaves the open salon to the receipt effect', () => {
    const map = new Map([[SALON, convo()]]);
    const changed = reconcileSalonUnread(
      map,
      { asOf: 1000, counts: { 'aaaaaaaa-0000-0000-0000-000000000001': 5 } },
      SALON,
      ME,
      beginUnreadReconcile()
    );
    expect(changed).toEqual([]);
    expect(map.get(SALON)?.unreadCount).toBe(0);
  });

  it('leaves a salon opened while the answer was in flight - its mark is not on the server yet', () => {
    const map = new Map([
      [SALON, convo()],
      [OTHER, convo({ id: OTHER })],
    ]);
    const token = beginUnreadReconcile();
    noteSalonOpened(SALON); // opened and closed again after the request left
    reconcileSalonUnread(
      map,
      {
        asOf: 1000,
        counts: {
          'aaaaaaaa-0000-0000-0000-000000000001': 5,
          'aaaaaaaa-0000-0000-0000-000000000002': 2,
        },
      },
      null,
      ME,
      token
    );
    expect(map.get(SALON)?.unreadCount).toBe(0);
    expect(map.get(OTHER)?.unreadCount).toBe(2);
  });

  it('a salon opened BEFORE the request was made is not exempt', () => {
    const map = new Map([[SALON, convo()]]);
    noteSalonOpened(SALON);
    reconcileSalonUnread(
      map,
      { asOf: 1000, counts: { 'aaaaaaaa-0000-0000-0000-000000000001': 1 } },
      null,
      ME,
      beginUnreadReconcile()
    );
    expect(map.get(SALON)?.unreadCount).toBe(1);
  });

  it('ignores a conversation that is not a salon', () => {
    const map = new Map([['some-group-id', convo({ id: 'some-group-id', unreadCount: 2 })]]);
    reconcileSalonUnread(map, { asOf: 1, counts: {} }, null, ME, beginUnreadReconcile());
    expect(map.get('some-group-id')?.unreadCount).toBe(2);
  });
});

describe('reconcileSalonUnreadFromServer', () => {
  it('drops an answer asked under a session that has since ended', async () => {
    resetSalonUnread();
    const map = new Map([[SALON, convo()]]);
    const logs: string[] = [];
    await reconcileSalonUnreadFromServer({
      conversations: map,
      selectedId: null,
      userId: ME,
      reason: 'test',
      log: (m) => logs.push(m),
      fetchCounts: async () => {
        resetSalonUnread();
        return { asOf: 1, counts: { [SALON.replace('channel_', '')]: 4 } };
      },
    });
    expect(map.get(SALON)?.unreadCount).toBe(0);
    expect(logs.join()).toContain('dropped');
  });
});

/**
 * "Marquer tout comme lu" on a community (2026-10-13). The clear covers what the screen COUNTED, on
 * the server's clock, and nothing later; and it empties the badge without moving the reader's own
 * watermark, which is the "Lu par" receipt the other members see.
 */
describe('communityUnreadUpTo', () => {
  beforeEach(() => resetSalonUnread());

  it('is 0 when nothing was ever counted - there is nothing to clear', () => {
    expect(communityUnreadUpTo(new Map([[SALON, convo()]]), [SALON])).toBe(0);
  });

  it('is the later of the last server count and the newest message held in those salons', async () => {
    const map = new Map([
      [SALON, convo({ messages: [msg('a', 1500)] as never })],
      [OTHER, convo({ id: OTHER, messages: [msg('z', 9000)] as never })],
    ]);
    await reconcileSalonUnreadFromServer({
      conversations: map,
      selectedId: null,
      userId: ME,
      reason: 'test',
      log: () => {},
      fetchCounts: async () => ({ asOf: 2000, counts: {} }),
    });
    // OTHER is not in this community: its newer message must not stretch the clear.
    expect(communityUnreadUpTo(map, [SALON])).toBe(2000);
    expect(communityUnreadUpTo(map, [SALON, OTHER])).toBe(9000);
  });

  it('forgets the last count when the session ends', async () => {
    const map = new Map([[SALON, convo()]]);
    await reconcileSalonUnreadFromServer({
      conversations: map,
      selectedId: null,
      userId: ME,
      reason: 'test',
      log: () => {},
      fetchCounts: async () => ({ asOf: 2000, counts: {} }),
    });
    resetSalonUnread();
    expect(communityUnreadUpTo(map, [SALON])).toBe(0);
  });
});

describe('clearSalonUnreadLocally', () => {
  it('empties a badge the server counted, and keeps the watermark where it was', () => {
    const map = new Map([[SALON, convo({ unreadCount: 4, readWatermarks: { me: 100 } })]]);
    const changed = clearSalonUnreadLocally(map, [SALON], 2000, ME);
    expect(changed).toEqual([SALON]);
    expect(map.get(SALON)?.unreadCount).toBe(0);
    expect(map.get(SALON)?.readWatermarks).toEqual({ me: 100 });
  });

  it('keeps a message that landed after the instant cleared', () => {
    const map = new Map([
      [SALON, convo({ unreadCount: 3, messages: [msg('a', 1500), msg('late', 2500)] as never })],
    ]);
    clearSalonUnreadLocally(map, [SALON], 2000, ME);
    expect(map.get(SALON)?.unreadCount).toBe(1);
  });

  it('never raises a count, and leaves salons outside the list alone', () => {
    const map = new Map([
      [SALON, convo({ unreadCount: 0, messages: [msg('late', 2500)] as never })],
      [OTHER, convo({ id: OTHER, unreadCount: 5 })],
    ]);
    expect(clearSalonUnreadLocally(map, [SALON], 2000, ME)).toEqual([]);
    expect(map.get(SALON)?.unreadCount).toBe(0);
    expect(map.get(OTHER)?.unreadCount).toBe(5);
  });

  it('ignores a key that is not a salon, and one this device does not hold', () => {
    const map = new Map([['some-group-id', convo({ id: 'some-group-id', unreadCount: 2 })]]);
    expect(clearSalonUnreadLocally(map, ['some-group-id', OTHER], 2000, ME)).toEqual([]);
    expect(map.get('some-group-id')?.unreadCount).toBe(2);
  });
});

describe('parseSalonUnreadAnswer', () => {
  it('reads the documented shape and drops non-positive counts', () => {
    expect(parseSalonUnreadAnswer({ asOf: 5, counts: { ABC: 2, def: 0 } })).toEqual({
      asOf: 5,
      counts: { abc: 2 },
      muted: [],
    });
  });
  it('refuses a shape it does not know rather than half-applying it', () => {
    expect(parseSalonUnreadAnswer(null)).toBeNull();
    expect(parseSalonUnreadAnswer({ counts: {} })).toBeNull();
    expect(parseSalonUnreadAnswer({ asOf: 'x', counts: {} })).toBeNull();
  });
});

/** 2026-10-18: a muted salon shows no badge, from the server's answer and from the live tally. */
describe('a muted salon', () => {
  const RAW = 'aaaaaaaa-0000-0000-0000-000000000001';
  beforeEach(() => resetSalonUnread());

  it('is cleared by the answer, whatever landed live after it', () => {
    const map = new Map([
      [SALON, convo({ unreadCount: 4, messages: [msg('late', 2000)] as never })],
      [OTHER, convo({ id: OTHER, unreadCount: 0 })],
    ]);
    const changed = reconcileSalonUnread(
      map,
      { asOf: 1000, counts: { 'aaaaaaaa-0000-0000-0000-000000000002': 2 }, muted: [RAW] },
      null,
      ME,
      beginUnreadReconcile()
    );
    expect(changed.sort()).toEqual([OTHER, SALON].sort());
    expect(map.get(SALON)?.unreadCount).toBe(0);
    expect(map.get(OTHER)?.unreadCount).toBe(2);
    expect(isSalonMuted(SALON)).toBe(true);
    expect(isSalonMuted(OTHER)).toBe(false);
  });

  it('is unmuted by a later answer that no longer names it', () => {
    const map = new Map([[SALON, convo()]]);
    reconcileSalonUnread(
      map,
      { asOf: 1, counts: {}, muted: [RAW] },
      null,
      ME,
      beginUnreadReconcile()
    );
    reconcileSalonUnread(map, { asOf: 2, counts: {}, muted: [] }, null, ME, beginUnreadReconcile());
    expect(isSalonMuted(SALON)).toBe(false);
  });

  it('follows a level the member chooses here, for either id spelling', () => {
    noteSalonNotificationLevel(RAW, 'none');
    expect(isSalonMuted(SALON)).toBe(true);
    expect(isSalonMuted(RAW)).toBe(true);
    noteSalonNotificationLevel(SALON, 'mentions');
    expect(isSalonMuted(SALON)).toBe(false);
  });

  // An answer asked BEFORE the member muted here, landing after, must not undo the mute (nor an
  // unmute): the local choice is newer than what the server counted.
  it('keeps a level chosen here after the answer was asked for', () => {
    const map = new Map([[SALON, convo({ unreadCount: 3 })]]);
    const token = beginUnreadReconcile();
    noteSalonNotificationLevel(RAW, 'none');
    reconcileSalonUnread(map, { asOf: 1, counts: { [RAW]: 3 }, muted: [] }, null, ME, token);
    expect(isSalonMuted(SALON)).toBe(true);
    expect(map.get(SALON)?.unreadCount).toBe(0);

    const token2 = beginUnreadReconcile();
    noteSalonNotificationLevel(RAW, 'all');
    reconcileSalonUnread(map, { asOf: 2, counts: {}, muted: [RAW] }, null, ME, token2);
    expect(isSalonMuted(SALON)).toBe(false);
  });

  it('follows an answer asked after the level was chosen here', () => {
    const map = new Map([[SALON, convo()]]);
    noteSalonNotificationLevel(RAW, 'none');
    reconcileSalonUnread(map, { asOf: 1, counts: {}, muted: [] }, null, ME, beginUnreadReconcile());
    expect(isSalonMuted(SALON)).toBe(false);
  });

  it('is read from the wire, an older server naming none included', () => {
    expect(
      parseSalonUnreadAnswer({ asOf: 1, counts: {}, muted: [RAW.toUpperCase(), 7] })?.muted
    ).toEqual([RAW]);
    expect(parseSalonUnreadAnswer({ asOf: 1, counts: {} })?.muted).toEqual([]);
  });
});

/** One `unread-counts` request per boot (2026-10-19): the community load and the live stream coming back ask together. */
describe('reconcileSalonUnreadFromServer - one request in flight', () => {
  beforeEach(() => resetSalonUnread());

  function ask(
    map: Map<string, Conversation>,
    fetchCounts: () => Promise<unknown>,
    settleOwedMarks?: () => Promise<number>,
    reason = 'test'
  ) {
    return reconcileSalonUnreadFromServer({
      conversations: map,
      selectedId: null,
      userId: ME,
      reason,
      log: () => {},
      fetchCounts,
      settleOwedMarks,
    });
  }

  it('joins a request already on the wire when nothing was owed, and asks again afterwards', async () => {
    const map = new Map([[SALON, convo()]]);
    let calls = 0;
    const answer = { asOf: 1, counts: { [SALON.replace('channel_', '')]: 2 } };
    const fetchCounts = async () => {
      calls++;
      return answer;
    };
    await Promise.all([
      ask(map, fetchCounts, async () => 0),
      ask(map, fetchCounts, async () => 0),
      ask(map, fetchCounts),
    ]);
    expect(calls).toBe(1);
    expect(map.get(SALON)?.unreadCount).toBe(2);
    // Nothing is held past the answer.
    await ask(map, fetchCounts);
    expect(calls).toBe(2);
  });

  it('does NOT join when this caller just delivered read marks: the request in flight predates them', async () => {
    const map = new Map([[SALON, convo()]]);
    let calls = 0;
    const fetchCounts = async () => {
      calls++;
      return { asOf: 1, counts: {} };
    };
    await Promise.all([ask(map, fetchCounts, async () => 0), ask(map, fetchCounts, async () => 1)]);
    expect(calls).toBe(2);
  });

  it('does not remember a failure: every joiner is refused, the next caller asks again', async () => {
    const map = new Map([[SALON, convo()]]);
    let calls = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = async () => {
      calls++;
      throw new Error('offline');
    };
    await Promise.all([
      ask(map, failing, undefined, 'first'),
      ask(map, failing, undefined, 'second'),
    ]);
    expect(calls).toBe(1);
    // Each caller reports its own failure exactly once, under its own reason.
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('first: counts not refreshed'),
      expect.stringContaining('second: counts not refreshed'),
    ]);
    await ask(map, async () => {
      calls++;
      return { asOf: 1, counts: {} };
    });
    expect(calls).toBe(2);
    warn.mockRestore();
  });

  it('never hands an answer asked under an ended session to the next one', async () => {
    const map = new Map([[SALON, convo()]]);
    let calls = 0;
    const slow = ask(map, async () => {
      calls++;
      return { asOf: 1, counts: {} };
    });
    resetSalonUnread();
    await ask(map, async () => {
      calls++;
      return { asOf: 1, counts: {} };
    });
    await slow;
    expect(calls).toBe(2);
  });

  it('does NOT join a request sent before another caller delivered a mark (R0 on the wire, A flushed it, B owes nothing)', async () => {
    localStorage.clear();
    const map = new Map([[SALON, convo()]]);
    const key = SALON.replace('channel_', '');
    let serverHoldsMark = false;
    const requests: boolean[] = [];
    let releaseR0: () => void = () => {};
    const r0Gate = new Promise<void>((resolve) => (releaseR0 = resolve));
    let r0Started: () => void = () => {};
    const r0OnTheWire = new Promise<void>((resolve) => (r0Started = resolve));
    // The server counts against the marks it holds AT THE TIME OF THE REQUEST.
    const counted = () => {
      const held = serverHoldsMark;
      requests.push(held);
      return { asOf: 1, counts: { [key]: held ? 0 : 3 } };
    };
    const r0 = ask(
      map,
      async () => {
        r0Started();
        const answer = counted();
        await r0Gate;
        return answer;
      },
      async () => 0,
      'R0'
    );
    await r0OnTheWire;
    // A owes a mark: the REAL flush delivers it, but A's settle has not RETURNED yet (its caller is
    // still waiting), so R0 is still the entry on the wire when B arrives.
    recordSalonReadMark(ME, key, 500);
    let aDelivered: () => void = () => {};
    const aFlushed = new Promise<void>((resolve) => (aDelivered = resolve));
    let aReturn: () => void = () => {};
    const aMayReturn = new Promise<void>((resolve) => (aReturn = resolve));
    const a = ask(
      map,
      async () => counted(),
      async () => {
        const n = await flushSalonReadMarks(ME, async () => {
          serverHoldsMark = true;
        });
        aDelivered();
        await aMayReturn;
        return n;
      },
      'A'
    );
    await aFlushed;
    // B owes nothing (A already delivered it) and R0 predates the mark: B must ask for itself.
    await ask(
      map,
      async () => counted(),
      () => flushSalonReadMarks(ME, async () => {}),
      'B'
    );
    aReturn();
    await a;
    releaseR0();
    await r0;
    // R0, A, B: B asked for itself and its request was counted AFTER the mark reached the server.
    expect(requests).toEqual([false, true, true]);
    localStorage.clear();
  });
});
