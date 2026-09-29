import { describe, expect, it, vi } from 'vitest';

/**
 * A SALON'S READ RECEIPT, ARRIVING LIVE.
 *
 * Until 2026-09-29 a salon had no read state at all: the DM receipt travels over MLS, a salon has no
 * MLS group, and nothing replaced it - so every sender in a community saw "Envoyé" for ever
 * (reported by the user). The server now fans out `channel.read`, and this branch merges it into the
 * same `readWatermarks` the "Lu par" row reads for a group. What must hold is the merge's own law:
 * it only rises, so a late or repeated event changes nothing.
 */

vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));
vi.mock('$lib/utils/graine/channelSeal', () => ({ openChannelMessage: vi.fn() }));
vi.mock('$lib/utils/chat/channelCrypto', () => ({ reportUnreadableChannelMessage: vi.fn() }));
vi.mock('$lib/proto/codec', () => ({ decodeAppMessage: vi.fn() }));
vi.mock('$lib/envelope', () => ({ serializeEnvelope: vi.fn(), mkTextEnvelope: vi.fn() }));
vi.mock('$lib/utils/chat/messageUtils', () => ({
  appMsgToEnvelope: vi.fn(),
  appMsgToChannelSystemEnvelope: vi.fn(),
}));
vi.mock('$lib/mls-client/incomingDelivery', () => ({ parseServerTimestampMs: vi.fn() }));

const { handleChannelEvent } = await import('./channelEventHandler');

function ctx(conversations: Map<string, unknown>, log = vi.fn()) {
  return {
    conversations,
    addMessageToChat: vi.fn(),
    log,
    onOutOfSync: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function read(userId: string, at: number, channelId = 'c1') {
  return { type: 'channel.read', data: { channelId, workspaceId: 'ws', userId, at } };
}

describe('channelEventHandler - channel.read', () => {
  it('raises the reader mark on the salon it names, and nothing on a lower one', async () => {
    const conversations = new Map<string, unknown>([
      ['channel_c1', { id: 'channel_c1', messages: [], readWatermarks: { alice: 100 } }],
    ]);

    await handleChannelEvent(read('Bob', 200), ctx(conversations));
    await handleChannelEvent(read('alice', 50), ctx(conversations));

    expect((conversations.get('channel_c1') as { readWatermarks: unknown }).readWatermarks).toEqual(
      {
        alice: 100,
        bob: 200,
      }
    );
  });

  it('touches nothing for a salon this device does not hold', async () => {
    const conversations = new Map<string, unknown>();
    const log = vi.fn();

    await handleChannelEvent(read('bob', 200, 'elsewhere'), ctx(conversations, log));

    expect(conversations.size).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('accuses an event with no reader to address', async () => {
    const log = vi.fn();
    await handleChannelEvent(
      { type: 'channel.read', data: { channelId: 'c1', at: 1 } },
      ctx(new Map(), log)
    );
    expect(log.mock.calls.join('\n')).toContain('channel.read arrived with no userId');
  });
});
