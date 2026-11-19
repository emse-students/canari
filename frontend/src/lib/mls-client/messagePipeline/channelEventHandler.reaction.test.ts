// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '$lib/types';

/**
 * A SALON REACTION FRAME IS HANDED TO THE REACTION TRIGGER (review of #3792).
 *
 * `onInboundReaction` is told what the frame changed and whose message it landed on. The author was
 * read from the in-memory window alone, so a reaction to MY older message in a salon not opened this
 * session read as "not mine" and was announced by nobody while the push was dropped in front. It is
 * read from the window, then - for news only - from the salon's stored page, then from the author the
 * frame STATES (`target_author_id`): screen, store, claim, as on the MLS path; and a store that cannot
 * answer is said as such.
 */

vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
const applyChannelReactionFrame = vi.fn(() => true);
vi.mock('$lib/stores/reactionStore.svelte', () => ({
  applyChannelReactionFrame: (...a: unknown[]) => applyChannelReactionFrame(...(a as [])),
}));
const openChannelMessageProving = vi.fn(async () => ({
  bytes: new Uint8Array(),
  authorProven: true,
}));
vi.mock('$lib/utils/graine/channelSeal', () => ({
  openChannelMessageProving: () => openChannelMessageProving(),
}));
const reportUnreadableChannelMessage = vi.fn((): boolean => false);
vi.mock('$lib/utils/chat/channelCrypto', () => ({
  reportUnreadableChannelMessage: () => reportUnreadableChannelMessage(),
}));
const REACTION = { messageId: 'srv-mine', emoji: '+1', at: 1_700_000_000_123, removed: false };
const decodeAppMessage = vi.fn((): unknown => ({ reaction: REACTION }));
vi.mock('$lib/proto/codec', () => ({ decodeAppMessage: () => decodeAppMessage() }));
vi.mock('$lib/envelope', () => ({ serializeEnvelope: vi.fn(), mkTextEnvelope: vi.fn() }));
vi.mock('$lib/utils/chat/messageUtils', () => ({
  appMsgToEnvelope: vi.fn(),
  appMsgToChannelSystemEnvelope: vi.fn(),
}));
vi.mock('$lib/mls-client/incomingDelivery', () => ({ parseServerTimestampMs: vi.fn() }));
vi.mock('$lib/mls-client/tabMessageSync', () => ({ publishTabMessageUpdate: vi.fn() }));
vi.mock('$lib/utils/chat/messaging', () => ({ forgetDeliveredSalonSend: vi.fn() }));

const { handleChannelEvent } = await import('./channelEventHandler');
const { takeOwedLiveDecision, resetOwedLiveDecisions, oweLiveDecision, owedLiveGeneration } =
  await import('$lib/utils/chat/owedLiveFrames');

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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

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
      authorLookupFailed: false,
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

  it('screen, store, THEN claim: the stored row outranks the author the frame states', async () => {
    // The MLS path's order (`setupMessageHandler`: the held row, else `target_author_id`) and the
    // `InboundReaction.messageAuthorId` contract: a claim is the reactor's word, a row is this
    // device's own record (review of #3792, round 3).
    decodeAppMessage.mockReturnValueOnce({ reaction: { ...REACTION, targetAuthorId: 'someone' } });
    const { ctx, onInboundReaction, getMessagesByIds } = setup({
      shown: false,
      stored: { senderId: 'me' },
    });
    await handleChannelEvent(frame, ctx);
    expect(getMessagesByIds).toHaveBeenCalledWith('channel_c1', ['srv-mine'], 'device-key');
    expect(onInboundReaction.mock.calls[0][0]).toMatchObject({ messageAuthorId: 'me' });
  });

  it('names the author the frame STATES when the store holds no row', async () => {
    decodeAppMessage.mockReturnValueOnce({ reaction: { ...REACTION, targetAuthorId: 'me' } });
    const { ctx, onInboundReaction, getMessagesByIds } = setup({ shown: false });
    await handleChannelEvent(frame, ctx);
    expect(getMessagesByIds).toHaveBeenCalledTimes(1);
    expect(onInboundReaction.mock.calls[0][0]).toMatchObject({
      messageAuthorId: 'me',
      authorLookupFailed: false,
    });
  });

  it('falls to the stated author when the store fails - and says the store failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    decodeAppMessage.mockReturnValueOnce({ reaction: { ...REACTION, targetAuthorId: 'me' } });
    const { ctx, onInboundReaction } = setup({ shown: false, stored: 'throws' });
    await handleChannelEvent(frame, ctx);
    expect(onInboundReaction.mock.calls[0][0]).toMatchObject({
      messageAuthorId: 'me',
      authorLookupFailed: true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a frame that is no news takes the stated author without a store read', async () => {
    applyChannelReactionFrame.mockReturnValueOnce(false);
    decodeAppMessage.mockReturnValueOnce({ reaction: { ...REACTION, targetAuthorId: 'me' } });
    const { ctx, onInboundReaction, getMessagesByIds } = setup({ shown: false });
    await handleChannelEvent(frame, ctx);
    expect(getMessagesByIds).not.toHaveBeenCalled();
    expect(onInboundReaction.mock.calls[0][0]).toMatchObject({ messageAuthorId: 'me' });
  });

  it('THE DEFECT: a frame naming no author, in a salon not held in memory, reads its stored page', async () => {
    const { ctx, onInboundReaction, getMessagesByIds } = setup({
      shown: false,
      stored: { senderId: 'me' },
    });
    await handleChannelEvent(frame, ctx);
    expect(getMessagesByIds).toHaveBeenCalledWith('channel_c1', ['srv-mine'], 'device-key');
    expect(onInboundReaction.mock.calls[0][0]).toMatchObject({ messageAuthorId: 'me' });
  });

  it.each([
    ['a replay', () => applyChannelReactionFrame.mockReturnValueOnce(false)],
    [
      'a removal',
      () => decodeAppMessage.mockReturnValueOnce({ reaction: { ...REACTION, removed: true } }),
    ],
  ])(
    'pays no store read, and warns nothing, for %s - the trigger discards it anyway',
    async (_, arrange) => {
      arrange();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ctx, onInboundReaction, getMessagesByIds } = setup({
        shown: false,
        stored: 'throws',
      });
      await handleChannelEvent(frame, ctx);
      expect(getMessagesByIds).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(onInboundReaction.mock.calls[0][0]).toMatchObject({
        messageAuthorId: null,
        authorLookupFailed: false,
      });
    }
  );

  it.each([
    ['held nowhere', { shown: false }],
    ['with no store this session', { shown: false, storage: false }],
  ] as const)(
    'names nobody for a row %s, and no failure: nothing failed to answer',
    async (_, o) => {
      const { ctx, onInboundReaction } = setup(o);
      await handleChannelEvent(frame, ctx);
      expect(onInboundReaction.mock.calls[0][0]).toMatchObject({
        messageAuthorId: null,
        authorLookupFailed: false,
      });
    }
  );

  it.each([
    ['stored under a key this device cannot open', 'unreadable'],
    ['in a store that cannot be read', 'throws'],
  ] as const)('names nobody, says the store FAILED, and warns, for a row %s', async (_, stored) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, onInboundReaction } = setup({ shown: false, stored });
    await handleChannelEvent(frame, ctx);
    expect(onInboundReaction.mock.calls[0][0]).toMatchObject({
      messageAuthorId: null,
      authorLookupFailed: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('its author is unknown'));
  });
});

/**
 * A LIVE REACTION THAT ARRIVED BEFORE ITS SEED IS STILL OWED A LIVE DECISION (Mi 9T, 1.7.0-alpha.10,
 * 2026-11-18). The first frame of the reactor's new seed session could not be opened, the seed landed
 * in the same drain, and the repair re-read the salon as history - which raises nothing - while the
 * push was dropped in front: nobody drew it. The live path now parks its decision under the row's id
 * for the reader that opens it (`owedLiveFrames.ts`).
 */
describe('channelEventHandler - a live reaction opened only after its seed', () => {
  const unopenable = { ...frame, data: { ...frame.data, silent: true } };

  beforeEach(() => {
    vi.clearAllMocks();
    resetOwedLiveDecisions();
    openChannelMessageProving.mockRejectedValueOnce(new Error('no seed'));
  });

  it('parks the decision of a SILENT repairable row, and the reader that opens it raises it LIVE', async () => {
    reportUnreadableChannelMessage.mockReturnValueOnce(true);
    const { ctx, onInboundReaction } = setup({ shown: true });
    await handleChannelEvent(unopenable, ctx);
    expect(onInboundReaction).not.toHaveBeenCalled();

    const decide = takeOwedLiveDecision('c1', 'srv-r', 'test');
    expect(decide).not.toBeNull();
    decide!(
      {
        targetMessageId: 'srv-mine',
        senderId: 'peer',
        emoji: '+1',
        at: 1_700_000_000_123,
        removed: false,
        targetAuthorId: null,
      },
      true
    );
    await vi.waitFor(() => expect(onInboundReaction).toHaveBeenCalledTimes(1));
    expect(onInboundReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: 'channel_c1',
        messageId: 'srv-mine',
        reactorId: 'peer',
        changed: true,
        messageAuthorId: 'me',
        live: true,
      })
    );
    // Only once: the decision is taken, never shared by a second reader.
    expect(takeOwedLiveDecision('c1', 'srv-r', 'test')).toBeNull();
  });

  it.each([
    ['a row that is not repairable (a refused or floored row)', false, true],
    ['a row that is not silent (a line, which has its own unread path)', true, false],
  ])('parks nothing for %s', async (_, repairable, silent) => {
    reportUnreadableChannelMessage.mockReturnValueOnce(repairable);
    const { ctx } = setup({ shown: true });
    await handleChannelEvent({ ...frame, data: { ...frame.data, silent } }, ctx);
    expect(takeOwedLiveDecision('c1', 'srv-r', 'test')).toBeNull();
  });

  it('parks nothing for a handler whose session ENDED while it awaited the open', async () => {
    reportUnreadableChannelMessage.mockReturnValueOnce(true);
    let release!: () => void;
    openChannelMessageProving.mockReset();
    openChannelMessageProving.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('no seed'));
        })
    );
    const { ctx } = setup({ shown: true });
    const handled = handleChannelEvent(unopenable, ctx);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // The sign-out empties the seed layer (`setGraineRuntime(null)` -> this reset) mid-open.
    resetOwedLiveDecisions();
    release();
    await handled;
    expect(takeOwedLiveDecision('c1', 'srv-r', 'test')).toBeNull();
  });

  it('a reset forgets every parked decision, and a stale generation parks nothing', () => {
    const before = owedLiveGeneration();
    oweLiveDecision('c1', 'srv-x', before, vi.fn());
    resetOwedLiveDecisions();
    expect(takeOwedLiveDecision('c1', 'srv-x', 'test')).toBeNull();
    oweLiveDecision('c1', 'srv-y', before, vi.fn());
    expect(takeOwedLiveDecision('c1', 'srv-y', 'test')).toBeNull();
  });
});
