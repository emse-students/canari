import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '$lib/types';

/**
 * THE BROADCAST FRAME OF A SALON MESSAGE AND THE AUTHOR'S OWN ECHO (WP-OFF-2).
 *
 * The frame and the POST's reply race and either may win; whichever lands second must find nothing to
 * do. And only the AUTHOR owns an echo: a frame from another member that happens to carry the same
 * client UUID inside its ciphertext must not re-key it.
 */

vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));
vi.mock('$lib/utils/graine/channelSeal', () => ({
  openChannelMessage: vi.fn(async () => new Uint8Array()),
}));
vi.mock('$lib/utils/chat/channelCrypto', () => ({ reportUnreadableChannelMessage: vi.fn() }));
vi.mock('$lib/proto/codec', () => ({ decodeAppMessage: vi.fn(() => ({ messageId: 'local-1' })) }));
vi.mock('$lib/envelope', () => ({ serializeEnvelope: vi.fn(), mkTextEnvelope: vi.fn() }));
vi.mock('$lib/utils/chat/messageUtils', () => ({
  appMsgToEnvelope: vi.fn(() => ({ content: 'hello', options: {} })),
  appMsgToChannelSystemEnvelope: vi.fn(),
}));
vi.mock('$lib/mls-client/incomingDelivery', () => ({ parseServerTimestampMs: vi.fn() }));
vi.mock('$lib/mls-client/tabMessageSync', () => ({ publishTabMessageUpdate: vi.fn() }));

const { handleChannelEvent } = await import('./channelEventHandler');
const { applySalonEchoChange } = await import('$lib/utils/chat/salonEcho');

const echo: ChatMessage = {
  id: 'local-1',
  senderId: 'me',
  content: 'hello',
  timestamp: new Date(1000),
  isOwn: true,
  status: 'sending',
  awaitingServerId: true,
};

function setup() {
  const conversations = new Map<string, unknown>([
    ['channel_c1', { id: 'channel_c1', messages: [{ ...echo }], lastMessageAt: 1000 }],
  ]);
  const ctx = {
    conversations,
    userId: 'Me',
    addMessageToChat: vi.fn(async () => {}),
    log: vi.fn(),
    onOutOfSync: vi.fn(),
  } as never;
  const ids = () =>
    (conversations.get('channel_c1') as { messages: ChatMessage[] }).messages.map((m) => m.id);
  return { conversations, ctx, ids };
}

const frame = (senderId: string) => ({
  type: 'channel.message.created',
  data: { channelId: 'c1', messageId: 'srv-1', senderId, ciphertext: 'x', nonce: 'n' },
});

describe('channelEventHandler - the salon echo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('frame first, then the POST reply: one row, the reply is a no-op', async () => {
    const { conversations, ctx, ids } = setup();
    await handleChannelEvent(frame('me'), ctx);
    expect(ids()).toEqual(['srv-1']);
    const changed = applySalonEchoChange(
      conversations as never,
      'channel_c1',
      'local-1',
      {
        kind: 'settled',
        serverId: 'srv-1',
      },
      vi.fn()
    );
    expect(changed).toBe(false);
    expect(ids()).toEqual(['srv-1']);
  });

  it('POST reply first, then the frame: the frame finds nothing to re-key', async () => {
    const { conversations, ctx, ids } = setup();
    applySalonEchoChange(
      conversations as never,
      'channel_c1',
      'local-1',
      {
        kind: 'settled',
        serverId: 'srv-1',
      },
      vi.fn()
    );
    expect(ids()).toEqual(['srv-1']);
    await handleChannelEvent(frame('me'), ctx);
    expect(ids()).toEqual(['srv-1']);
  });

  it("another member's frame carrying the same client UUID never re-keys this echo", async () => {
    const { ctx, ids } = setup();
    await handleChannelEvent(frame('mallory'), ctx);
    expect(ids()).toEqual(['local-1']);
  });
});
