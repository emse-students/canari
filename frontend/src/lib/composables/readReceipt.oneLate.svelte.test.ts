// @vitest-environment happy-dom
/**
 * THE READ RECEIPT WAS ONE OR TWO MESSAGES LATE (owner, 2026-11-05, production 1.6.5, web, a DM).
 *
 * `A` sends m1 and m2, `B` reacts to m2, `A` sends m3 and m4, `B` answers quoting m4 - and on `A`'s
 * screen `B`'s head stayed under m2 while m3 and m4 showed a single check.
 *
 * The cause, measured on dev with a logpoint on `readMarkTarget` in two bench browsers: every
 * message `B` received through a drain sat in memory WITHOUT its server time (`batchAddMessages`
 * built the shown row without `serverTimestamp` and gave it only to the stored one). Its read key
 * therefore fell back on the author's `sentAt`, so `B`'s mark was taken on `A`'s clock - and `A`
 * compares it with the time the SERVER accepted its message, which is later. The reaction was not
 * the cause: m2 was simply the last message sent before the gap. A reload "fixed" it, because the
 * stored rows had the field.
 *
 * Every device here is its own store driven through the REAL seams: `batchAddMessages` for an
 * arrival (the drain), `applyReactionFrame` for a reaction, `readMarkTarget` for the mark the
 * receipt effect of `MainChatPage` decides, `handleSystemEvent` for the `read_watermark` frame, and
 * `readersOf` for what `ChatMessageGroups` draws. No wall clock: every instant is a fixed number,
 * and each author's clock runs BEHIND the server's by {@link SKEW} plus the network.
 *
 * docs/wiki/frontend/modules/chat.md, "Read receipts".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// The sender lookup an arrival's notification waits on answers from the cache, offline.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/utils/users/displayName')>();
  return {
    ...real,
    resolveNotificationSenderName: async (
      senderId: string,
      conversationKey: string,
      convo: Parameters<typeof real.notificationSenderName>[2]
    ) => real.notificationSenderName(senderId, conversationKey, convo),
  };
});
// Same import-cycle break as the other useMessaging suites.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));
vi.mock('$lib/mls-client/tabLeader', () => ({ getIsTabLeader: () => false }));

const { useMessaging } = await import('./useMessaging.svelte');
const { handleSystemEvent } = await import('$lib/mls-client/messagePipeline/systemMessageHandler');
const { applyReactionFrame } = await import('$lib/mls-client/messagePipeline/reactionFrame');
const { readMarkTarget, readWatermarkFrameData, readersOf, watermarkFor } =
  await import('$lib/utils/chat/readState');
const { noteServerTime, serverTimeSeen, resetServerClockForTests } =
  await import('$lib/utils/chat/serverClock');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { ChatMessage, Conversation, MessageReaction } from '$lib/types';

const A = 'user-a';
const B = 'user-b';
const CONVO = 'dm-a-b';
/** How far every author's clock runs behind the server's (measured on dev: ~0.7 s). */
const SKEW = 700;
/** The network, from the tap to the server's acceptance. */
const LATENCY = 120;

/** One message: composed at `sentAt` on its author's clock, accepted by the server after. */
interface Sent {
  id: string;
  by: string;
  sentAt: number;
  serverAt: number;
}

/** A message `by` composes at `t` (author clock); the server accepts it SKEW + LATENCY later. */
const compose = (id: string, by: string, t: number): Sent => ({
  id,
  by,
  sentAt: t,
  serverAt: t + SKEW + LATENCY,
});

/** One device: its own store, its own messaging, the account it is signed into. */
interface Device {
  userId: string;
  ctx: MessagingContext;
  messaging: ReturnType<typeof useMessaging>;
  reactions: Map<string, MessageReaction[]>;
}

function device(userId: string): Device {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        contactName: CONVO,
        conversationType: 'direct',
        lifecycle: 'active',
        messages: [],
        unreadCount: 0,
        lastMessageAt: 0,
        readWatermarks: {},
        serverReadWatermarks: {},
      } as never,
    ],
  ]);
  const ctx = {
    conversations,
    userId,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    // The conversation is OPEN on every device: the reader is looking at it as messages land.
    selectedContact: CONVO,
    storage: null,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessagingContext;
  return {
    userId,
    ctx,
    messaging: useMessaging(),
    reactions: new Map<string, MessageReaction[]>(),
  };
}

const convoOf = (d: Device) => d.ctx.conversations.get(CONVO)!;

/**
 * The author's own device holds its message as the outbox leaves it once the send answered: its
 * `sentAt` and the server's `receivedAt` (`patchServerTimestamp`).
 */
function holdOwn(d: Device, m: Sent) {
  const c = convoOf(d);
  const row: ChatMessage = {
    id: m.id,
    senderId: m.by,
    content: m.id,
    timestamp: new Date(m.sentAt),
    serverTimestamp: m.serverAt,
    isOwn: true,
    isSystem: false,
    status: 'sent',
  } as ChatMessage;
  d.ctx.conversations.set(CONVO, { ...c, messages: [...c.messages, row] });
  noteServerTime(d.userId, m.serverAt);
}

/**
 * A frame reaching `d` through a drain: the delivery's `queuedCreatedAt` is the server's time, the
 * body's `sentAt` is the author's - exactly what the pipeline hands `batchAddMessages`.
 */
async function deliver(d: Device, ...msgs: Sent[]) {
  for (const m of msgs) noteServerTime(d.userId, m.serverAt);
  await d.messaging.batchAddMessages(
    msgs.map((m) => ({
      senderId: m.by,
      content: m.id,
      messageId: m.id,
      timestamp: new Date(m.sentAt),
      serverTimestamp: m.serverAt,
    })),
    CONVO,
    d.ctx,
    'arrival'
  );
}

/** `by` reacts to `target` on device `d` (its own optimistic update, or a peer's frame). */
async function react(d: Device, by: string, target: string, emoji: string, at: number) {
  await applyReactionFrame(
    {
      storage: null,
      deviceKey: () => 'k',
      conversations: d.ctx.conversations,
      messageReactions: d.reactions as never,
      log: vi.fn(),
    } as never,
    CONVO,
    by,
    { messageId: target, emoji, at },
    undefined,
    at
  );
}

/**
 * Device `d` READS the open conversation: the mark `MainChatPage`'s receipt effect decides
 * (`readMarkTarget`, bounded by what the server said to this account), or `null` when it moves
 * nothing - the effect then sends no frame.
 */
function read(d: Device): { at: number; serverAt: number } | null {
  const c = convoOf(d);
  const held = watermarkFor(c.serverReadWatermarks, d.userId);
  const target = readMarkTarget(c.messages, held, false, serverTimeSeen(d.userId));
  if (target <= held) return null;
  d.ctx.conversations.set(CONVO, {
    ...c,
    serverReadWatermarks: { ...c.serverReadWatermarks, [d.userId]: target },
  });
  return readWatermarkFrameData(target);
}

/** The `read_watermark` frame of `from` reaching device `d`, accepted by the server at `serverAt`. */
async function receiveMark(d: Device, from: string, frame: object, serverAt: number) {
  noteServerTime(d.userId, serverAt);
  await handleSystemEvent('read_watermark', frame, {
    mlsService: { getDeviceId: () => `device-of-${d.userId}` },
    storage: null,
    userId: d.userId,
    deviceKey: () => 'k',
    conversations: d.ctx.conversations,
    messageReactions: d.reactions,
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => CONVO,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: convoOf(d),
    convoKey: CONVO,
    senderNorm: from,
    persistMlsStateNow: vi.fn(),
    deliveryMeta: { queuedCreatedAt: serverAt },
  } as never);
}

/** Who has read `id` on device `d` - what `ChatMessageGroups` draws as the double check. */
function readersOn(d: Device, id: string): string[] {
  const c = convoOf(d);
  const msg = c.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`${id} is not on ${d.userId}'s device`);
  return readersOf(msg, c.readWatermarks, c.serverReadWatermarks);
}

/** The last own message with a reader: where the DM draws the peer's head (`lastReadOwnMessageId`). */
function headOn(d: Device): string | null {
  const own = convoOf(d).messages.filter((m) => m.isOwn && !m.isSystem);
  for (let i = own.length - 1; i >= 0; i--) {
    if (readersOn(d, own[i].id).length > 0) return own[i].id;
  }
  return null;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  localStorage.clear();
  resetServerClockForTests();
});

describe('the read receipt sits on the message the reader read, not one or two before', () => {
  it('an arrival keeps the server time it was delivered with, on the row SHOWN', async () => {
    const b = device(B);
    const m1 = compose('m1', A, 10_000);
    await deliver(b, m1);
    expect(convoOf(b).messages[0].serverTimestamp).toBe(m1.serverAt);
  });

  it("the owner's case: B reacts to m2, A sends m3 and m4, B reads them open - the head is on m4", async () => {
    const a = device(A);
    const b = device(B);

    // A sends m1 and m2; B has the conversation open and reads them as they land.
    const m1 = compose('m1', A, 10_000);
    const m2 = compose('m2', A, 10_400);
    holdOwn(a, m1);
    holdOwn(a, m2);
    await deliver(b, m1, m2);
    const first = read(b);
    expect(first).not.toBeNull();
    await receiveMark(a, B, first!, 12_000);
    expect(headOn(a)).toBe('m2');

    // B reacts to m2 - on B's own device, and A receives the frame.
    await react(b, B, 'm2', '👍', 13_000);
    await react(a, B, 'm2', '👍', 13_000);

    // A sends m3 (a reply) and m4 in quick succession; they land while B has the conversation open.
    const m3 = compose('m3', A, 20_000);
    const m4 = compose('m4', A, 20_300);
    holdOwn(a, m3);
    holdOwn(a, m4);
    await deliver(b, m3, m4);
    const second = read(b);
    expect(second).not.toBeNull();
    await receiveMark(a, B, second!, 23_000);

    expect(readersOn(a, 'm3')).toEqual([B]);
    expect(readersOn(a, 'm4')).toEqual([B]);
    expect(headOn(a)).toBe('m4');
  });

  it("the other direction: A reads B's answer, which carries A's reaction, and B sees the head on it", async () => {
    const a = device(A);
    const b = device(B);
    const r1 = compose('r1', B, 30_000);
    const r2 = compose('r2', B, 30_200);
    holdOwn(b, r1);
    holdOwn(b, r2);
    await deliver(a, r1);
    await react(a, A, 'r1', '❤️', 30_100);
    await react(b, A, 'r1', '❤️', 30_100);
    await deliver(a, r2);
    const mark = read(a);
    expect(mark).not.toBeNull();
    await receiveMark(b, A, mark!, 32_000);

    expect(readersOn(b, 'r2')).toEqual([A]);
    expect(headOn(b)).toBe('r2');
  });

  it("a mark from the reader's OTHER device counts, and reaches the author's other device too", async () => {
    const a = device(A);
    const a2 = device(A); // A's second device: holds A's messages as frames from A's first one.
    const b = device(B);
    const b2 = device(B); // B's newly added device - the one that reads.
    const m1 = compose('m1', A, 40_000);
    const m2 = compose('m2', A, 40_250);
    holdOwn(a, m1);
    holdOwn(a, m2);
    await deliver(a2, m1, m2);
    await deliver(b, m1, m2);
    await deliver(b2, m1, m2);

    const mark = read(b2);
    expect(mark).not.toBeNull();
    for (const d of [a, a2, b]) await receiveMark(d, B, mark!, 42_000);

    expect(headOn(a)).toBe('m2');
    expect(headOn(a2)).toBe('m2');
    // B's first device took its own account's read: it has nothing left to announce.
    expect(read(b)).toBeNull();
  });
});
