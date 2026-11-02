import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage } from '$lib/types';

// The role is the ONLY input either publisher reads, so it is the only thing stubbed. Stubbing the
// whole leadership module rather than driving a real election keeps these cases about the gate.
let isLeader = false;
vi.mock('$lib/mls-client/tabLeader', () => ({
  getIsTabLeader: () => isLeader,
}));

import {
  publishComposedMessage,
  publishConversationRead,
  publishReadState,
  publishTabMessageUpdate,
  publishUnreadCounts,
  subscribeTabMessageUpdates,
  type TabMessageEvent,
} from './tabMessageSync';

/** Every `BroadcastChannel` this module opens, so a test can read what was posted. */
const posted: unknown[] = [];
const listeners: ((ev: MessageEvent) => void)[] = [];

class FakeBroadcastChannel {
  constructor(readonly name: string) {}
  postMessage(data: unknown) {
    posted.push(data);
  }
  addEventListener(_type: string, fn: (ev: MessageEvent) => void) {
    listeners.push(fn);
  }
  removeEventListener(_type: string, fn: (ev: MessageEvent) => void) {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  }
  close() {}
}

function message(id: string): ChatMessage {
  return {
    id,
    senderId: 'me',
    content: 'hello',
    timestamp: new Date(1_700_000_000_000),
  } as unknown as ChatMessage;
}

const composed = {
  type: 'own_message_composed',
  conversationId: 'c1',
  message: message('m1'),
  lastMessageAt: 1_700_000_000_000,
} satisfies TabMessageEvent;

const relayed = {
  type: 'message_added',
  conversationId: 'c1',
  message: message('m2'),
  lastMessageAt: 1_700_000_000_000,
  unreadCount: 0,
} satisfies TabMessageEvent;

beforeEach(() => {
  posted.length = 0;
  listeners.length = 0;
  isLeader = false;
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});

afterEach(() => vi.unstubAllGlobals());

describe('tabMessageSync - who may speak, and about what', () => {
  // THE EXISTING RULE, pinned because the new one is defined as its mirror image and a test that
  // only asserts the new half would pass just as well if this one had quietly inverted.
  it('relays a conversation update only from the leader', () => {
    isLeader = true;
    publishTabMessageUpdate(relayed);
    expect(posted).toEqual([relayed]);

    posted.length = 0;
    isLeader = false;
    publishTabMessageUpdate(relayed);
    expect(posted).toEqual([]);
  });

  // TAB-4b, 2026-09-05: a follower composing a message told nobody, so the leader's list stayed
  // short until it re-read. It is the one fact a follower holds and the leader does not.
  it('announces a composed message only from a follower - the exact mirror', () => {
    isLeader = false;
    publishComposedMessage(composed);
    expect(posted).toEqual([composed]);

    posted.length = 0;
    isLeader = true;
    publishComposedMessage(composed);
    expect(posted).toEqual([]);
  });

  // The leader's silence above is not an omission: its own composed message is already on the
  // channel as `message_added` from the same call site, and two copies of one row would only give
  // the receivers something to deduplicate.
  it('leaves the leader exactly one way to announce its own message', () => {
    isLeader = true;
    publishTabMessageUpdate(relayed);
    publishComposedMessage(composed);
    expect(posted).toEqual([relayed]);
  });

  // The badge went stale when a conversation was read in another tab, because nothing on this
  // channel ever said so (reported 2026-09-28). Reading happens in whichever tab is open, so - like
  // a composed message - it must reach every OTHER tab regardless of leader/follower role.
  it('announces a conversation read from either role', () => {
    isLeader = true;
    publishConversationRead('c1', 1_700_000_000_000);
    expect(posted).toEqual([
      { type: 'conversation_read', conversationId: 'c1', readAt: 1_700_000_000_000 },
    ]);

    posted.length = 0;
    isLeader = false;
    publishConversationRead('c1', 1_700_000_000_000);
    expect(posted).toEqual([
      { type: 'conversation_read', conversationId: 'c1', readAt: 1_700_000_000_000 },
    ]);
  });

  it('delivers a composed message to a subscriber', () => {
    const handler = vi.fn();
    subscribeTabMessageUpdates(handler);

    for (const fn of listeners) fn({ data: composed } as MessageEvent);

    expect(handler).toHaveBeenCalledWith(composed);
  });

  // The same channel carries outbox coordination, and a conversation handler must never see it.
  it('keeps outbox coordination away from the conversation handler', () => {
    const handler = vi.fn();
    subscribeTabMessageUpdates(handler);

    for (const fn of listeners) fn({ data: { type: 'outbox_flush_request' } } as MessageEvent);

    expect(handler).not.toHaveBeenCalled();
  });

  it('stops delivering once unsubscribed', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeTabMessageUpdates(handler);
    unsubscribe();

    for (const fn of listeners) fn({ data: composed } as MessageEvent);

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('tabMessageSync - the read state a leader received', () => {
  it('is relayed by the leader only, both maps whole', () => {
    const convo = { readWatermarks: { peer: 10 }, serverReadWatermarks: { me: 20 } };
    publishReadState('g1', convo);
    publishUnreadCounts({ channel_s1: 2 });
    expect(posted).toEqual([]);

    isLeader = true;
    publishReadState('g1', convo);
    publishUnreadCounts({ channel_s1: 2 });
    publishUnreadCounts({});
    expect(posted).toEqual([
      { type: 'read_state', conversationId: 'g1', ...convo },
      { type: 'unread_counts', counts: { channel_s1: 2 } },
    ]);
  });

  it('reaches the conversation handler', () => {
    const handler = vi.fn();
    subscribeTabMessageUpdates(handler);
    const event = { type: 'read_state', conversationId: 'g1', readWatermarks: { peer: 10 } };

    for (const fn of listeners) fn({ data: event } as MessageEvent);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("a reading carries the reading tab's mark, a selection none", () => {
    publishConversationRead('g1', 100, { at: 90, clock: 'server' });
    publishConversationRead('g1', 100);
    expect(posted).toEqual([
      {
        type: 'conversation_read',
        conversationId: 'g1',
        readAt: 100,
        mark: { at: 90, clock: 'server' },
      },
      { type: 'conversation_read', conversationId: 'g1', readAt: 100 },
    ]);
  });
});
