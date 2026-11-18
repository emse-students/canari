import { describe, expect, it, vi } from 'vitest';

/**
 * THE ADMIN BADGES ARE TOLD, NOT POLLED (lead, 2026-11-18): `admin.queues.changed` carries nothing,
 * and its one effect is that the badges ask the server for their counts - never an "unhandled" line.
 */

const counts = vi.hoisted(() => ({ loadAdminQueueCounts: vi.fn(async () => undefined) }));
vi.mock('$lib/admin/adminQueueCounts.svelte', () => ({
  ADMIN_QUEUES_CHANGED_FRAME: 'admin.queues.changed',
  loadAdminQueueCounts: counts.loadAdminQueueCounts,
}));
vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));
vi.mock('$lib/utils/graine/channelSeal', () => ({ openChannelMessageProving: vi.fn() }));
vi.mock('$lib/utils/chat/channelCrypto', () => ({ reportUnreadableChannelMessage: vi.fn() }));
vi.mock('$lib/proto/codec', () => ({ decodeAppMessage: vi.fn() }));
vi.mock('$lib/envelope', () => ({ serializeEnvelope: vi.fn(), mkTextEnvelope: vi.fn() }));
vi.mock('$lib/utils/chat/messageUtils', () => ({
  appMsgToEnvelope: vi.fn(),
  appMsgToChannelSystemEnvelope: vi.fn(),
}));
vi.mock('$lib/mls-client/incomingDelivery', () => ({ parseServerTimestampMs: vi.fn() }));

const { handleChannelEvent } = await import('./channelEventHandler');

describe('channelEventHandler - admin.queues.changed', () => {
  it('asks the badges for their counts, and logs no unhandled type', async () => {
    const log = vi.fn();
    await handleChannelEvent(
      { type: 'admin.queues.changed', data: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        conversations: new Map(),
        userId: 'me',
        addMessageToChat: vi.fn(),
        log,
        onOutOfSync: vi.fn(),
      } as any
    );
    expect(counts.loadAdminQueueCounts).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled'));
  });
});
