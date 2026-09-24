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
  publishTabMessageUpdate,
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
