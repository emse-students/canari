import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve names offline: identity function so the handler runs without the user store / network.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
}));

import { handleSystemEvent } from './systemMessageHandler';
import {
  decodeAppMessage,
  encodeAppMessage,
  mkText,
  mkVisibleSystem,
  type IAppMessage,
} from '$lib/proto/codec';
import {
  appMessageSentAtMs,
  appMsgToEnvelope,
  normalizeMessageId,
  resolveMessageTimestamp,
} from '$lib/utils/chat/messageUtils';
import { insertMessageOrdered } from '$lib/utils/chat/messageOrder';
import { receivedNoticeTime } from '$lib/utils/chat/visibleNotices';
import type { AddMessageToChatOptions, ChatMessage } from '$lib/types';

/**
 * A NOTICE IS DATED BY THE EVENT IT DESCRIBES, NEVER BY WHEN THIS DEVICE LEARNT OF IT.
 *
 * The owner's report (v1.6.0, iPhone, 2026-11-01): a group is created on the PC with two members,
 * the PC writes "X a ajouté A, B au groupe", a conversation follows - and the phone, opening the
 * group for the FIRST time, draws that line at the BOTTOM, below every message that followed it.
 * The live handler wrote the notice with no date, so `addMessageToChat` stamped it with the phone's
 * clock at the moment its drain reached the frame - hours after the event.
 */

const T0 = Date.UTC(2026, 10, 1, 9, 0, 0); // the PC creates the group and adds A and B
const ACCEPT_LAG_MS = 40; // the server's acceptance of the frame, a moment after its sentAt
const LATE_DRAIN = T0 + 6 * 60 * 60 * 1000; // the phone opens the group six hours later

/**
 * One frame over the wire, as the phone's delivery queue hands it over: encoded and decoded (so
 * `sentAt` arrives as protobuf gives it), with the server's acceptance beside it.
 */
function overTheWire(frame: IAppMessage, serverAt: number) {
  const decoded = decodeAppMessage(encodeAppMessage(frame));
  if (!decoded) throw new Error('frame did not survive the wire');
  return { decoded, deliveryMeta: { queuedCreatedAt: serverAt } };
}

/**
 * The phone's conversation, and a writer that MATERIALISES rows the way `addMessageToChat` does -
 * `resolveMessageTimestamp` for the stamped time, the option's `serverTimestamp`, and
 * `insertMessageOrdered` for the place - so the order asserted is the order the screen draws.
 */
function phoneConversation(userId: string) {
  const convo = { id: 'g1', lifecycle: 'active', messages: [] as ChatMessage[], name: 'Groupe' };
  const conversations = new Map<string, any>([['g1', convo]]);
  const addMessageToChat = vi.fn(
    async (senderId: string, content: string, key: string, options: AddMessageToChatOptions) => {
      const c = conversations.get(key);
      const row: ChatMessage = {
        id: normalizeMessageId(options.messageId) ?? crypto.randomUUID(),
        senderId: senderId.toLowerCase(),
        content,
        timestamp: resolveMessageTimestamp(
          options,
          (id) => c.messages.find((m: ChatMessage) => m.id === id),
          senderId === userId
        ),
        isOwn: senderId === userId,
        isSystem: options.isSystem === true,
        serverTimestamp: options.serverTimestamp,
      };
      conversations.set(key, { ...c, messages: insertMessageOrdered(c.messages, row) });
    }
  );
  const ctx = {
    mlsService: {},
    storage: null,
    userId,
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat,
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => 'g1',
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo,
    convoKey: 'g1',
    persistMlsStateNow: vi.fn(),
  };
  return { ctx, conversations, addMessageToChat };
}

/** Hands a text frame to the writer exactly as `setupMessageHandler` does for a received one. */
async function receiveText(
  phone: ReturnType<typeof phoneConversation>,
  sender: string,
  frame: IAppMessage,
  serverAt: number
) {
  const { decoded, deliveryMeta } = overTheWire(frame, serverAt);
  const envelope = appMsgToEnvelope(decoded, deliveryMeta.queuedCreatedAt)!;
  await phone.addMessageToChat(sender, envelope.content, 'g1', {
    ...envelope.options,
    messageId: normalizeMessageId(decoded.messageId),
    serverTimestamp: deliveryMeta.queuedCreatedAt,
  });
}

/** Hands a system frame to the handler exactly as `setupMessageHandler` does (both of its sites). */
async function receiveSystem(
  phone: ReturnType<typeof phoneConversation>,
  sender: string,
  frame: IAppMessage,
  serverAt: number
) {
  const { decoded, deliveryMeta } = overTheWire(frame, serverAt);
  await handleSystemEvent(decoded.system!.event!, JSON.parse(decoded.system!.data || '{}'), {
    ...phone.ctx,
    convo: phone.conversations.get('g1'),
    senderNorm: sender,
    messageId: normalizeMessageId(decoded.messageId),
    sentAt: appMessageSentAtMs(decoded.sentAt),
    deliveryMeta,
  } as never);
}

/** A text frame minted at `sentAt` by its author. */
function textAt(id: string, text: string, sentAt: number): IAppMessage {
  return { ...mkText(text), messageId: id, sentAt };
}

describe('a notice drawn from a received frame is dated by the frame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(LATE_DRAIN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('first open, hours late: "X added A, B" stays ABOVE the conversation that followed it', async () => {
    // The owner's phone (user `owner`, another device of the actor) drains its queue in order: the
    // addition first, then the conversation the PC had with A afterwards - all of it six hours late.
    vi.setSystemTime(T0);
    const added = mkVisibleSystem('memberAdded', JSON.stringify({ newUsers: ['a', 'b'] }));
    vi.setSystemTime(LATE_DRAIN);
    const phone = phoneConversation('owner');

    await receiveSystem(phone, 'owner', added, T0 + ACCEPT_LAG_MS);
    await receiveText(phone, 'a', textAt('m1', 'salut', T0 + 60_000), T0 + 60_040);
    await receiveText(phone, 'owner', textAt('m2', 'ca va ?', T0 + 120_000), T0 + 120_040);
    await receiveText(phone, 'a', textAt('m3', 'oui', T0 + 180_000), T0 + 180_040);

    const rows = phone.conversations.get('g1').messages as ChatMessage[];
    expect(rows.map((r) => r.id)).toEqual([added.messageId, 'm1', 'm2', 'm3']);
    const notice = rows[0];
    expect(notice.isSystem).toBe(true);
    expect(notice.timestamp.getTime()).toBe(T0);
    expect(notice.serverTimestamp).toBe(T0 + ACCEPT_LAG_MS);
  });

  it('the order holds whatever order the frames are processed in', async () => {
    // The texts reached the phone first (a history page, a second drain) and the notice after.
    vi.setSystemTime(T0);
    const added = mkVisibleSystem('memberAdded', JSON.stringify({ newUsers: ['a', 'b'] }));
    vi.setSystemTime(LATE_DRAIN);
    const phone = phoneConversation('owner');

    await receiveText(phone, 'a', textAt('m1', 'salut', T0 + 60_000), T0 + 60_040);
    await receiveText(phone, 'a', textAt('m2', 'oui', T0 + 120_000), T0 + 120_040);
    await receiveSystem(phone, 'owner', added, T0 + ACCEPT_LAG_MS);

    const ids = (phone.conversations.get('g1').messages as ChatMessage[]).map((r) => r.id);
    expect(ids).toEqual([added.messageId, 'm1', 'm2']);
  });

  it('every notice branch writes the frame time, the server acceptance included', async () => {
    const events: [string, Record<string, unknown>][] = [
      ['memberAdded', { newUsers: ['carol'] }],
      ['memberRemoved', { targetUser: 'carol' }],
      ['memberLeft', { userId: 'bob' }],
      ['groupRenamed', { newName: 'Nouveau nom' }],
      ['groupImageChanged', { imageMediaId: 'media-7' }],
      ['groupDeleted', {}],
      ['channel_invitation', { channelId: 'c1', inviteeId: 'me' }],
    ];
    for (const [event, data] of events) {
      const phone = phoneConversation('me');
      await handleSystemEvent(event, data, {
        ...phone.ctx,
        senderNorm: 'bob',
        messageId: 'frame-id',
        sentAt: T0,
        deliveryMeta: { queuedCreatedAt: T0 + ACCEPT_LAG_MS },
      } as never);
      expect(phone.addMessageToChat, event).toHaveBeenCalledOnce();
      const options = phone.addMessageToChat.mock.calls[0][3];
      expect(options.timestamp?.getTime(), event).toBe(T0);
      expect(options.serverTimestamp, event).toBe(T0 + ACCEPT_LAG_MS);
    }
  });

  it('a frame from an older build (no sentAt) is dated by the server acceptance', async () => {
    const phone = phoneConversation('me');
    await handleSystemEvent('memberAdded', { newUsers: ['carol'] }, {
      ...phone.ctx,
      senderNorm: 'bob',
      deliveryMeta: { queuedCreatedAt: T0 + ACCEPT_LAG_MS },
    } as never);
    const options = phone.addMessageToChat.mock.calls[0][3];
    expect(options.timestamp?.getTime()).toBe(T0 + ACCEPT_LAG_MS);
    expect(options.serverTimestamp).toBe(T0 + ACCEPT_LAG_MS);
  });

  it('with no durable time at all it draws NOTHING and says so at ERROR - never the local clock', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const phone = phoneConversation('me');
    await expect(
      handleSystemEvent('memberAdded', { newUsers: ['carol'] }, {
        ...phone.ctx,
        senderNorm: 'bob',
        messageId: 'frame-id',
      } as never)
    ).resolves.toBe(true);
    expect(phone.addMessageToChat).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REFUSED to draw'));
  });
});

describe('receivedNoticeTime', () => {
  it('takes the frame sentAt as the stamp and the server acceptance as the order key', () => {
    expect(receivedNoticeTime(T0, T0 + 40)).toEqual({
      timestamp: new Date(T0),
      serverTimestamp: T0 + 40,
    });
  });

  it('stamps with the server acceptance when the frame carries no sentAt', () => {
    expect(receivedNoticeTime(undefined, T0 + 40)).toEqual({
      timestamp: new Date(T0 + 40),
      serverTimestamp: T0 + 40,
    });
  });

  it('keeps the sentAt alone when the delivery carried no server time', () => {
    expect(receivedNoticeTime(T0, undefined)).toEqual({ timestamp: new Date(T0) });
  });

  it('answers null, not "now", when neither time is usable', () => {
    expect(receivedNoticeTime(undefined, undefined)).toBeNull();
    expect(receivedNoticeTime(0, Number.NaN)).toBeNull();
  });
});
