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
vi.mock('$lib/utils/graine/channelSeal', () => ({ openChannelMessageProving: vi.fn() }));
vi.mock('$lib/utils/chat/channelCrypto', () => ({ reportUnreadableChannelMessage: vi.fn() }));
vi.mock('$lib/proto/codec', () => ({ decodeAppMessage: vi.fn() }));
vi.mock('$lib/envelope', () => ({ serializeEnvelope: vi.fn(), mkTextEnvelope: vi.fn() }));
vi.mock('$lib/utils/chat/messageUtils', () => ({
  appMsgToEnvelope: vi.fn(),
  appMsgToChannelSystemEnvelope: vi.fn(),
}));
vi.mock('$lib/mls-client/incomingDelivery', () => ({ parseServerTimestampMs: vi.fn() }));
const recordNativeReadElsewhere = vi.fn();
vi.mock('$lib/utils/nativeNotification', () => ({
  recordNativeReadElsewhere: (...args: unknown[]) => recordNativeReadElsewhere(...args),
}));

const { handleChannelEvent } = await import('./channelEventHandler');

function ctx(conversations: Map<string, unknown>, log = vi.fn()) {
  return {
    conversations,
    userId: 'me',
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

  it('my own mark from another device clears the unread count this device draws', async () => {
    const msg = (id: string, at: number) => ({
      id,
      senderId: 'bob',
      isOwn: false,
      isSystem: false,
      timestamp: new Date(at),
    });
    const conversations = new Map<string, unknown>([
      [
        'channel_c1',
        { id: 'channel_c1', unreadCount: 2, messages: [msg('a', 100), msg('b', 200)] },
      ],
    ]);

    await handleChannelEvent(read('Me', 200), ctx(conversations));

    const c = conversations.get('channel_c1') as { unreadCount: number; readWatermarks: unknown };
    expect(c.unreadCount).toBe(0);
    expect(c.readWatermarks).toEqual({ me: 200 });
  });

  // The salon's Android banner goes by the socket too (owner's report, 2026-11-20): the WebView
  // posted it, and the `channel_read` push alone left it standing while the app was in front.
  it('my own mark from another device dismisses the salon banner, and only mine does', async () => {
    recordNativeReadElsewhere.mockClear();
    const conversations = new Map<string, unknown>([
      ['channel_c1', { id: 'channel_c1', unreadCount: 1, messages: [] }],
    ]);

    await handleChannelEvent(read('bob', 200), ctx(conversations));
    expect(recordNativeReadElsewhere).not.toHaveBeenCalled();

    await handleChannelEvent(read('Me', 200), ctx(conversations));
    expect(recordNativeReadElsewhere).toHaveBeenCalledExactlyOnceWith(
      'channel_c1',
      'channel.read',
      200,
      'stamped'
    );
  });

  // Review of #3912: a mark already held moves nothing here, and the salon's banner still has to go.
  it('my own mark that moves nothing is still handed over', async () => {
    recordNativeReadElsewhere.mockClear();
    const conversations = new Map<string, unknown>([
      [
        'channel_c1',
        { id: 'channel_c1', unreadCount: 0, messages: [], readWatermarks: { me: 500 } },
      ],
    ]);

    await handleChannelEvent(read('me', 200), ctx(conversations));

    expect(recordNativeReadElsewhere).toHaveBeenCalledExactlyOnceWith(
      'channel_c1',
      'channel.read',
      200,
      'stamped'
    );
  });

  // Re-review of #3912: this row can lag behind the shade, so it does not decide the cancel - the
  // native side weighs the mark against the shade's own lines (`ReadElsewhereMarksTest`). The mark
  // is handed over all the same: an older message's post still on its way is refused against it.
  it('my own mark that leaves a newer message unread is still handed over - the shade decides', async () => {
    recordNativeReadElsewhere.mockClear();
    const msg = (id: string, at: number) => ({
      id,
      senderId: 'bob',
      isOwn: false,
      isSystem: false,
      timestamp: new Date(at),
    });
    const conversations = new Map<string, unknown>([
      [
        'channel_c1',
        { id: 'channel_c1', unreadCount: 2, messages: [msg('a', 100), msg('b', 200)] },
      ],
    ]);

    await handleChannelEvent(read('me', 100), ctx(conversations));

    expect((conversations.get('channel_c1') as { unreadCount: number }).unreadCount).toBe(1);
    expect(recordNativeReadElsewhere).toHaveBeenCalledExactlyOnceWith(
      'channel_c1',
      'channel.read',
      100,
      'stamped'
    );
  });

  it("someone else's mark never touches my count", async () => {
    const conversations = new Map<string, unknown>([
      ['channel_c1', { id: 'channel_c1', unreadCount: 2, messages: [] }],
    ]);

    await handleChannelEvent(read('bob', 200), ctx(conversations));

    expect((conversations.get('channel_c1') as { unreadCount: number }).unreadCount).toBe(2);
  });
  it('touches nothing for a salon this device does not hold', async () => {
    const conversations = new Map<string, unknown>();
    const log = vi.fn();

    await handleChannelEvent(read('bob', 200, 'elsewhere'), ctx(conversations, log));

    expect(conversations.size).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  // "Marquer tout comme lu" from another device of this account (2026-10-13): no watermark moves -
  // the clear is not a reading - and the counts are re-read, because the clearing device's bound is
  // not this device's to apply.
  it('a community cleared on a device of this account re-reads the counts and moves no mark', async () => {
    const conversations = new Map<string, unknown>([
      ['channel_c1', { id: 'channel_c1', unreadCount: 2, messages: [], readWatermarks: {} }],
    ]);
    const onSalonUnreadCleared = vi.fn();
    await handleChannelEvent(
      {
        type: 'channel.unread.cleared',
        data: { workspaceId: 'ws', userId: 'me', cleared: { c1: 200 } },
      },
      { ...ctx(conversations), onSalonUnreadCleared }
    );
    expect(onSalonUnreadCleared).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws' });
    expect(conversations.get('channel_c1')).toEqual({
      id: 'channel_c1',
      unreadCount: 2,
      messages: [],
      readWatermarks: {},
    });
  });

  it('accuses a cleared event with no community to address', async () => {
    const log = vi.fn();
    const onSalonUnreadCleared = vi.fn();
    await handleChannelEvent(
      { type: 'channel.unread.cleared', data: {} },
      { ...ctx(new Map(), log), onSalonUnreadCleared }
    );
    expect(onSalonUnreadCleared).not.toHaveBeenCalled();
    expect(log.mock.calls.join('\n')).toContain(
      'channel.unread.cleared arrived with no workspaceId'
    );
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
