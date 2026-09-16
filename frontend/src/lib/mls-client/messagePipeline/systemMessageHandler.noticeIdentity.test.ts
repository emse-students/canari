// Resolve names offline: identity function so the handler runs without the user store / network.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
}));

import { handleSystemEvent } from './systemMessageHandler';
import { applyReplaySystemEvent } from '$lib/utils/chat/historySystemEvents';
import { decodeAppMessage, encodeAppMessage, mkSystem, mkVisibleSystem } from '$lib/proto/codec';

/**
 * A VISIBLE SYSTEM NOTICE IS WRITTEN BY TWO PATHS THAT NEVER MEET, AND COPIED BY A THIRD.
 *
 * Live delivery (`handleSystemEvent`), the archive replay (`applyReplaySystemEvent`) and a peer's
 * `history_bundle` all produce the same bubble for one membership change, and every dedup in the
 * application compares message ids. Until the frame carried one, each path minted its own
 * `crypto.randomUUID()` - so one `memberAdded` drew one bubble PER REPLAY AND PER BUNDLE, durably.
 * Measured on prod 2026-09-16: one frame in the archive, four identical notices on screen.
 *
 * These tests pin the property that removes the whole class: THE ID COMES FROM THE FRAME, so the
 * two paths converge on one row. They are written against the frame rather than against either
 * path's internals, because it is the frame that both of them read.
 */
describe('a visible system notice carries the sender’s id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mkVisibleSystem mints an id and a clock; mkSystem still does not', () => {
    const visible = mkVisibleSystem('memberAdded', JSON.stringify({ newUsers: ['bob'] }));
    expect(visible.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(visible.sentAt)).toBeGreaterThan(0);

    // The transport and mutation frames are deliberately untouched: they change existing rows and
    // draw no bubble, so they have nothing to converge on.
    expect(mkSystem('history_bundle', '{}').messageId).toBeUndefined();
  });

  it('survives the wire: the id the sender minted is the id the receiver decodes', () => {
    const sent = mkVisibleSystem('memberAdded', JSON.stringify({ newUsers: ['bob'] }));
    const decoded = decodeAppMessage(encodeAppMessage(sent));
    expect(decoded?.messageId).toBe(sent.messageId);
    expect(decoded?.system?.event).toBe('memberAdded');
  });

  /** Minimal live context; `addMessageToChat` is the seam every notice branch writes through. */
  function makeCtx(messageId: string | undefined, overrides: Record<string, unknown> = {}) {
    const convo = { id: 'g1', lifecycle: 'active', messages: [], name: 'Groupe' };
    const conversations = new Map<string, any>([['g1', convo]]);
    return {
      mlsService: {},
      storage: null,
      userId: 'alice',
      deviceKeyB64: 'device-key',
      conversations,
      messageReactions: new Map(),
      addMessageToChat: vi.fn().mockResolvedValue(undefined),
      batchAddMessages: vi.fn(),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      saveConversation: vi.fn().mockResolvedValue(undefined),
      getSelectedContact: () => 'g1',
      setSelectedContact: vi.fn(),
      onReadStateAdvanced: vi.fn(),
      log: vi.fn(),
      convo,
      convoKey: 'g1',
      senderNorm: 'bob',
      messageId,
      persistMlsStateNow: vi.fn(),
      ...overrides,
    };
  }

  /** Every event that draws a notice, with the payload its branch requires. */
  const NOTICE_EVENTS: [string, Record<string, unknown>][] = [
    ['memberAdded', { newUsers: ['carol', 'dave'] }],
    ['memberRemoved', { targetUser: 'carol' }],
    // `senderNorm` is bob above, and only the leaver may announce its own departure - so the id
    // this branch must echo is bob's. It joined the list the day the branch existed at all.
    ['memberLeft', { userId: 'bob' }],
    ['groupRenamed', { newName: 'Nouveau nom' }],
    ['groupImageChanged', { imageMediaId: 'media-7' }],
  ];

  it.each(NOTICE_EVENTS)('live path: %s writes the row under the frame id', async (event, data) => {
    const ctx = makeCtx('frame-id-1');
    await handleSystemEvent(event, data, ctx as any);

    expect(ctx.addMessageToChat).toHaveBeenCalledTimes(1);
    const [senderId, , , options] = ctx.addMessageToChat.mock.calls[0];
    expect(senderId).toBe('system');
    expect(options).toMatchObject({ isSystem: true, messageId: 'frame-id-1' });
  });

  it('the two paths converge: live and replay write ONE id for one frame', async () => {
    const frame = mkVisibleSystem('memberAdded', JSON.stringify({ newUsers: ['carol'] }));
    const decoded = decodeAppMessage(encodeAppMessage(frame))!;

    // Live.
    const ctx = makeCtx(decoded.messageId ?? undefined);
    await handleSystemEvent(
      decoded.system!.event!,
      JSON.parse(decoded.system!.data || '{}'),
      ctx as any
    );
    const liveId = ctx.addMessageToChat.mock.calls[0][3].messageId;

    // Replay, reading the SAME frame out of the archive.
    const pushed: any[] = [];
    await applyReplaySystemEvent({
      parsed: { system: decoded.system, messageId: decoded.messageId ?? '' },
      msg: { sender_id: 'bob', timestamp: '2026-09-16T14:20:37.191Z' },
      contactName: 'g1',
      userId: 'alice',
      conversationId: 'g1',
      getConversation: () => ({ id: 'g1', messages: [] }),
      setConversation: vi.fn(),
      messageReactions: new Map(),
      reactionUpdates: new Map(),
      deletedMessages: new Map(),
      editedMessages: new Map(),
      readWatermarkUpdates: {},
      historyFloorUpdate: { at: 0 },
      pushPendingMessage: (entry: any) => pushed.push(entry),
    } as any);

    expect(pushed).toHaveLength(1);
    expect(liveId).toBe(decoded.messageId);
    expect(pushed[0].messageId).toBe(decoded.messageId);
    // THE PROPERTY THIS FILE EXISTS FOR: one frame, one row, whichever path read it.
    expect(pushed[0].messageId).toBe(liveId);
  });

  it('a frame from an older build still renders - it just cannot converge', async () => {
    const ctx = makeCtx(undefined);
    await handleSystemEvent('memberAdded', { newUsers: ['carol'] }, ctx as any);

    expect(ctx.addMessageToChat).toHaveBeenCalledTimes(1);
    // Undefined lets `addMessageToChat` mint one, which is the pre-fix behaviour and the reason
    // old frames stay duplicate-prone until the floor rises: see docs/wiki/legacy-compatibility.md.
    expect(ctx.addMessageToChat.mock.calls[0][3].messageId).toBeUndefined();
  });
});
