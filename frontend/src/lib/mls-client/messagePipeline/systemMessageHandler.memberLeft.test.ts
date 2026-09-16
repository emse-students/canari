// Resolve names offline: identity function so the handler runs without the user store / network.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
}));

import { handleSystemEvent } from './systemMessageHandler';
import { applyReplaySystemEvent } from '$lib/utils/chat/historySystemEvents';

/**
 * A MEMBER LEAVING WAS ANNOUNCED BY ONE PATH AND RENDERED BY THE OTHER.
 *
 * `leaveGroupAndBroadcast` has always broadcast `memberLeft`, and `applyReplaySystemEvent` has
 * always rendered it - but the LIVE handler had no branch for the event at all. So a departure
 * showed nothing to anybody at the moment it happened, and then surfaced on the next archive
 * replay at its original place in the scrollback, which reads as a thing that just occurred days
 * ago. `strayLeaves` even documents the opposite ("every remaining member rendered it") as the
 * reason it broadcasts nothing itself.
 *
 * These tests pin the branch and the one check it owes: the id in the payload is self-asserted,
 * where the sender is the identity MLS authenticated, so only the party that left may say so.
 */
describe('memberLeft, live', () => {
  /** Minimal live context; `addMessageToChat` is the seam every notice branch writes through. */
  function makeCtx(overrides: Record<string, unknown> = {}) {
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
      messageId: 'frame-id-1',
      persistMlsStateNow: vi.fn(),
      ...overrides,
    };
  }

  it('writes a notice naming the member who left, under the frame id', async () => {
    const ctx = makeCtx();
    await expect(handleSystemEvent('memberLeft', { userId: 'bob' }, ctx as any)).resolves.toBe(
      true
    );

    expect(ctx.addMessageToChat).toHaveBeenCalledTimes(1);
    const [senderId, content, convoKey, options] = ctx.addMessageToChat.mock.calls[0];
    expect(senderId).toBe('system');
    expect(content).toContain('bob');
    expect(convoKey).toBe('g1');
    expect(options).toMatchObject({ isSystem: true, messageId: 'frame-id-1' });
  });

  it('refuses a departure one member announces on another member’s behalf', async () => {
    const ctx = makeCtx();
    await expect(handleSystemEvent('memberLeft', { userId: 'carol' }, ctx as any)).resolves.toBe(
      true
    );

    expect(ctx.addMessageToChat).not.toHaveBeenCalled();
    // Never silent: a refused frame is the only trace a peer sending what it may not send leaves.
    expect(ctx.log.mock.calls.flat().join('\n')).toContain('only the leaver may announce');
  });

  it('draws nothing when the frame is our OWN departure reaching a sibling device', async () => {
    // MLS never returns a frame to the client that sent it, so the only way `userId === alice`
    // arrives here is another of alice's devices - which is about to lose the conversation to the
    // membership check, and must not be told "alice left the group" in the meantime.
    const ctx = makeCtx({ senderNorm: 'alice' });
    await expect(handleSystemEvent('memberLeft', { userId: 'alice' }, ctx as any)).resolves.toBe(
      true
    );

    expect(ctx.addMessageToChat).not.toHaveBeenCalled();
    expect(ctx.log.mock.calls.flat().join('\n')).toContain('from another device');
  });

  it('ignores a frame naming nobody rather than drawing an empty notice', async () => {
    const ctx = makeCtx();
    await expect(handleSystemEvent('memberLeft', {}, ctx as any)).resolves.toBe(true);
    expect(ctx.addMessageToChat).not.toHaveBeenCalled();
  });
});

describe('memberLeft, replay', () => {
  async function replay(senderId: string, data: Record<string, unknown>) {
    const pushed: any[] = [];
    await applyReplaySystemEvent({
      parsed: {
        system: { event: 'memberLeft', data: JSON.stringify(data) },
        messageId: 'frame-id-1',
      },
      msg: { sender_id: senderId, timestamp: '2026-09-16T14:20:37.191Z' },
      contactName: 'g1',
      userId: 'alice',
      conversationId: 'g1',
      getConversation: () => ({ id: 'g1', messages: [] }),
      setConversation: vi.fn(),
      messageReactions: new Map(),
      reactionUpdates: new Map(),
      deletedMessages: new Set(),
      editedMessages: new Map(),
      readWatermarkUpdates: {},
      historyFloorUpdate: {},
      pushPendingMessage: (msg: any) => pushed.push(msg),
    } as any);
    return pushed;
  }

  it('renders the departure the leaver announced', async () => {
    const pushed = await replay('bob', { userId: 'bob' });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].content).toContain('bob');
    expect(pushed[0].messageId).toBe('frame-id-1');
  });

  it('applies the SAME cross-check as the live path, so the archive cannot render a forgery', async () => {
    expect(await replay('bob', { userId: 'carol' })).toHaveLength(0);
  });
});
