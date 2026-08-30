/**
 * The unread badge must be DERIVED from this user's read watermark, never from "arrived just now".
 *
 * The two coincide only for live traffic. A history reconciliation delivers frames that are new to
 * THIS device and were read long ago on another one, and both add paths counted them as arrivals.
 * Interleaved with the read receipts the same replay carries - which zero the count - that made a
 * conversation flash read / unread / read for the whole reconciliation, reported from real use on
 * 2026-08-30.
 *
 * `isUnreadForUser` already existed and two other recompute sites already used it; these tests pin
 * the two that did not, and pin the property that matters more than either: the answer does not
 * depend on the ORDER the frames arrive in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

// Same import-cycle break as useMessaging.bulkIngest.svelte.test.ts: useMessaging -> chat/outbox ->
// chat/outboxMirror -> globalChatSingleton, which calls useMessaging() at module scope.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const { useMessaging } = await import('./useMessaging.svelte');
type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';

const ME = 'me-user-id';
const PEER = 'peer-user-id';
const CONVO = 'conversation-key';

/** Well before the watermark: a message this user read on another device long ago. */
const OLD = new Date('2026-01-01T10:00:00Z');
/** The instant this user's own read receipt says they had read up to. */
const WATERMARK = new Date('2026-01-01T12:00:00Z').getTime();
/** After the watermark: genuinely unseen, whichever device it reaches first. */
const FRESH = new Date('2026-01-01T14:00:00Z');

/**
 * @param watermarks - this user's read state, as a reconciliation would find it already loaded.
 *                     The conversation is deliberately NOT the selected one, so nothing zeroes the
 *                     count as a side effect of it being on screen.
 */
function makeContext(watermarks: Record<string, number> | undefined) {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        messages: [],
        unreadCount: 0,
        lastMessageAt: 0,
        readWatermarks: watermarks,
      } as never,
    ],
  ]);
  const ctx = {
    conversations,
    userId: ME,
    deviceKeyB64: 'device-key',
    authToken: 'token',
    selectedContact: 'some-other-conversation',
    storage: { saveMessage: vi.fn().mockResolvedValue(undefined) } as never,
    setAuthToken: vi.fn(),
    getSendError: () => '',
    setSendError: vi.fn(),
    getChatContainer: () => undefined,
    ensureMls: vi.fn(),
    log: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    verifyCurrentUserMembership: vi.fn().mockResolvedValue(true),
    playNotificationTone: vi.fn(),
    playReceiveTone: vi.fn(),
    sendSystemNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessagingContext;
  return { ctx, conversations };
}

const unreadIn = (conversations: SvelteMap<string, Conversation>) =>
  conversations.get(CONVO)?.unreadCount ?? 0;

describe('the unread badge during a history reconciliation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('raises no badge for a batch of messages this user had already read elsewhere', async () => {
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext({ [ME]: WATERMARK });

    await messaging.batchAddMessages(
      [
        { senderId: PEER, content: 'old one', messageId: 'old-1', timestamp: OLD },
        { senderId: PEER, content: 'old two', messageId: 'old-2', timestamp: OLD },
      ],
      CONVO,
      ctx
    );

    expect(unreadIn(conversations)).toBe(0);
  });

  it('still raises one for a batch genuinely above the watermark', async () => {
    // The guard must not silence the case the badge exists for - a catch-up after being offline
    // carries messages nobody has read anywhere.
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext({ [ME]: WATERMARK });

    await messaging.batchAddMessages(
      [
        { senderId: PEER, content: 'new one', messageId: 'new-1', timestamp: FRESH },
        { senderId: PEER, content: 'new two', messageId: 'new-2', timestamp: FRESH },
      ],
      CONVO,
      ctx
    );

    expect(unreadIn(conversations)).toBe(2);
  });

  it('gives the same answer whichever order old and new frames arrive in', async () => {
    // THE PROPERTY THE BLINK VIOLATED. A replay interleaves message frames and read receipts, and
    // the badge must describe the conversation's state rather than replay its history.
    const messaging = useMessaging();
    const oldFirst = makeContext({ [ME]: WATERMARK });
    await messaging.batchAddMessages(
      [
        { senderId: PEER, content: 'old', messageId: 'a-1', timestamp: OLD },
        { senderId: PEER, content: 'new', messageId: 'a-2', timestamp: FRESH },
      ],
      CONVO,
      oldFirst.ctx
    );

    const newFirst = makeContext({ [ME]: WATERMARK });
    await messaging.batchAddMessages(
      [
        { senderId: PEER, content: 'new', messageId: 'b-1', timestamp: FRESH },
        { senderId: PEER, content: 'old', messageId: 'b-2', timestamp: OLD },
      ],
      CONVO,
      newFirst.ctx
    );

    expect(unreadIn(oldFirst.conversations)).toBe(1);
    expect(unreadIn(newFirst.conversations)).toBe(unreadIn(oldFirst.conversations));
  });

  it('counts everything when this user has no watermark, which reads as "has read nothing"', async () => {
    // A genuinely new member, and the default the absence of a watermark must produce.
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext(undefined);

    await messaging.batchAddMessages(
      [
        { senderId: PEER, content: 'one', messageId: 'n-1', timestamp: OLD },
        { senderId: PEER, content: 'two', messageId: 'n-2', timestamp: FRESH },
      ],
      CONVO,
      ctx
    );

    expect(unreadIn(conversations)).toBe(2);
  });

  it('applies the same rule on the single-message path, system messages included', async () => {
    // This path asked a different question from its own batch twin until 2026-08-30: it forgot the
    // watermark, and it counted system messages the batch path had always excluded.
    const messaging = useMessaging();
    const { ctx, conversations } = makeContext({ [ME]: WATERMARK });

    await messaging.addMessageToChat(PEER, 'already read', CONVO, ctx, {
      messageId: 's-1',
      timestamp: OLD,
    });
    expect(unreadIn(conversations)).toBe(0);

    await messaging.addMessageToChat(PEER, 'someone joined', CONVO, ctx, {
      messageId: 's-2',
      timestamp: FRESH,
      isSystem: true,
    });
    expect(unreadIn(conversations)).toBe(0);

    await messaging.addMessageToChat(PEER, 'genuinely new', CONVO, ctx, {
      messageId: 's-3',
      timestamp: FRESH,
    });
    expect(unreadIn(conversations)).toBe(1);
  });
});
