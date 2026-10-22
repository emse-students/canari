import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A LIVE salon frame that carries no ciphertext.
 *
 * Every salon message is sealed under a Graine session, and the author a bubble shows is proven by
 * opening it (channel-encryption section 21). The server never sends anything else, and the history
 * path reads nothing else - so a frame without a ciphertext can only be a server naming an author it
 * cannot prove. It is refused at ERROR and rendered nowhere.
 */

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));

const { handleChannelEvent } = await import('./channelEventHandler');

const CHANNEL = '11111111-2222-3333-4444-555555555555';

function ctx() {
  const addMessageToChat = vi.fn().mockResolvedValue(undefined);
  return {
    addMessageToChat,
    context: {
      conversations: new Map([[`channel_${CHANNEL}`, { messages: [] }]]),
      addMessageToChat,
      log: vi.fn(),
      onOutOfSync: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a live salon frame without a ciphertext', () => {
  it('is refused at ERROR and rendered nowhere, whatever author it names', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { context, addMessageToChat } = ctx();

    await handleChannelEvent(
      {
        type: 'channel.message.created',
        data: {
          id: 'row-1',
          channelId: CHANNEL,
          senderId: 'alice',
          plaintext: 'hello',
          createdAt: '2026-10-22T12:00:00.000Z',
        },
      },
      context
    );

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(
      error.mock.calls.some(
        (c) => String(c[0]).includes('REFUSED') && String(c[0]).includes('row-1')
      )
    ).toBe(true);
  });
});
