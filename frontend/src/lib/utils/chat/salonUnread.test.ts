import { beforeEach, describe, expect, it } from 'vitest';
import type { Conversation } from '$lib/types';
import {
  beginUnreadReconcile,
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

describe('parseSalonUnreadAnswer', () => {
  it('reads the documented shape and drops non-positive counts', () => {
    expect(parseSalonUnreadAnswer({ asOf: 5, counts: { ABC: 2, def: 0 } })).toEqual({
      asOf: 5,
      counts: { abc: 2 },
    });
  });
  it('refuses a shape it does not know rather than half-applying it', () => {
    expect(parseSalonUnreadAnswer(null)).toBeNull();
    expect(parseSalonUnreadAnswer({ counts: {} })).toBeNull();
    expect(parseSalonUnreadAnswer({ asOf: 'x', counts: {} })).toBeNull();
  });
});
