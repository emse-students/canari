// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '$lib/types';

/**
 * A SALON REACTION FRAME IS HANDED TO THE REACTION TRIGGER (review of #3792).
 *
 * `onInboundReaction` is told what the frame changed and whose message it landed on. The author was
 * read from the in-memory window alone, so a reaction to MY older message in a salon not opened this
 * session read as "not mine" and was announced by nobody while the push was dropped in front. It is
 * read where the MLS path reads it: the window, then the salon's stored page.
 */

vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
const applyChannelReactionFrame = vi.fn(() => true);
vi.mock('$lib/stores/reactionStore.svelte', () => ({
  applyChannelReactionFrame: (...a: unknown[]) => applyChannelReactionFrame(...(a as [])),
}));
vi.mock('$lib/utils/graine/channelSeal', () => ({
  openChannelMessageProving: vi.fn(async () => ({ bytes: new Uint8Array(), authorProven: true })),
}));
vi.mock('$lib/utils/chat/channelCrypto', () => ({ reportUnreadableChannelMessage: vi.fn() }));
const REACTION = { messageId: 'srv-mine', emoji: '+1', at: 1_700_000_000_123, removed: false };
vi.mock('$lib/proto/codec', () => ({ decodeAppMessage: vi.fn(() => ({ reaction: REACTION })) }));
vi.mock('$lib/envelope', () => ({ serializeEnvelope: vi.fn(), mkTextEnvelope: vi.fn() }));
vi.mock('$lib/utils/chat/messageUtils', () => ({
  appMsgToEnvelope: vi.fn(),
  appMsgToChannelSystemEnvelope: vi.fn(),
}));
vi.mock('$lib/mls-client/incomingDelivery', () => ({ parseServerTimestampMs: vi.fn() }));
vi.mock('$lib/mls-client/tabMessageSync', () => ({ publishTabMessageUpdate: vi.fn() }));
vi.mock('$lib/utils/chat/messaging', () => ({ forgetDeliveredSalonSend: vi.fn() }));

const { handleChannelEvent } = await import('./channelEventHandler');

const mine: ChatMessage = {
  id: 'srv-mine',
  senderId: 'me',
  content: 'hello',
  timestamp: new Date(1000),
  isOwn: true,
};

function setup(opts: {
  shown: boolean;
  stored?: { senderId: string } | 'unreadable' | 'throws';
  storage?: boolean;
}) {
  const conversations = new Map<string, unknown>([
    [
      'channel_c1',
      { id: 'channel_c1', messages: opts.shown ? [{ ...mine }] : [], lastMessageAt: 0 },
    ],
  ]);
  const getMessagesByIds = vi.fn(async () => {
    if (opts.stored === 'throws') throw new Error('store closed');
    return {
      rows: new Map(
        opts.stored && typeof opts.stored === 'object' ? [['srv-mine', opts.stored]] : []
      ),
      unreadable: new Set(opts.stored === 'unreadable' ? ['srv-mine'] : []),
    };
  });
  const onInboundReaction = vi.fn();
  const ctx = {
    conversations,
    userId: 'me',
    addMessageToChat: vi.fn(async () => {}),
    log: vi.fn(),
    onOutOfSync: vi.fn(),
    onInboundReaction,
    storage: opts.storage === false ? null : { getMessagesByIds },
    deviceKey: () => 'device-key',
  } as never;
  return { ctx, onInboundReaction, getMessagesByIds };
}

const frame = {
  type: 'channel.message.created',
  data: { channelId: 'c1', messageId: 'srv-r', senderId: 'Peer', ciphertext: 'x', nonce: 'n' },
};

describe('channelEventHandler - a salon reaction reaches the reaction trigger', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hands the frame, LIVE, with the author of the shown row and its own instant', async () => {
    const { ctx, onInboundReaction, getMessagesByIds } = setup({ shown: true });
    await handleChannelEvent(frame, ctx);
    expect(onInboundReaction).toHaveBeenCalledWith({
      conversationKey: 'channel_c1',
      messageId: 'srv-mine',
      reactorId: 'peer',
      emoji: '+1',
      at: 1_700_000_000_123,
      removed: false,
      changed: true,
      messageAuthorId: 'me',
      live: true,
    });
    // The window answered: the store is not asked.
    expect(getMessagesByIds).not.toHaveBeenCalled();
  });

  it('carries what the store of reactions said - a replay changed nothing', async () => {
    applyChannelReactionFrame.mockReturnValueOnce(false);
    const { ctx, onInboundReaction } = setup({ shown: true });
    await handleChannelEvent(frame, ctx);
    expect(onInboundReaction.mock.calls[0][0]).toMatchObject({ changed: false });
  });

  it('THE DEFECT: a salon not held in memory names the author from its stored page', async () => {
    const { ctx, onInboundReaction, getMessagesByIds } = setup({
      shown: false,
      stored: { senderId: 'me' },
    });
    await handleChannelEvent(frame, ctx);
    expect(getMessagesByIds).toHaveBeenCalledWith('channel_c1', ['srv-mine'], 'device-key');
    expect(onInboundReaction.mock.calls[0][0]).toMatchObject({ messageAuthorId: 'me' });
  });

  it.each([
    ['held nowhere', { shown: false }],
    ['with no store this session', { shown: false, storage: false }],
  ] as const)(
    'names nobody for a row %s - the trigger then says it is unresolved',
    async (_, o) => {
      const { ctx, onInboundReaction } = setup(o);
      await handleChannelEvent(frame, ctx);
      expect(onInboundReaction.mock.calls[0][0]).toMatchObject({ messageAuthorId: null });
    }
  );

  it.each([
    ['stored under a key this device cannot open', 'unreadable'],
    ['in a store that cannot be read', 'throws'],
  ] as const)('names nobody, and WARNS, for a row %s', async (_, stored) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, onInboundReaction } = setup({ shown: false, stored });
    await handleChannelEvent(frame, ctx);
    expect(onInboundReaction.mock.calls[0][0]).toMatchObject({ messageAuthorId: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('its author is unknown'));
  });
});
