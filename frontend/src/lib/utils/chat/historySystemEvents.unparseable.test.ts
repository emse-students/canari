import { describe, expect, it, vi } from 'vitest';
import { canari } from '$lib/proto/canari.js';
import type { Conversation, ReadWatermarks } from '$lib/types';
import { applyReplaySystemEvent } from './historySystemEvents';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

/** A replayed system frame whose `data` is not JSON (a legacy channel sentence, a corrupt row). */
async function replay(event: string, data: string) {
  const convo = {
    id: 'c1',
    name: 't',
    messages: [],
    lifecycle: 'active',
  } as unknown as Conversation;
  const setConversation = vi.fn();
  const pushPendingMessage = vi.fn();
  await applyReplaySystemEvent({
    parsed: canari.AppMessage.fromObject({ system: { event, data } }),
    msg: { id: '1-0', sender_id: 'ana', content: '', timestamp: '2026-10-23T10:00:00.000Z' },
    contactName: 'c1',
    userId: 'me',
    conversationId: 'g-replay',
    nicknameRoster: { getGroupMemberIdentities: async () => [] },
    getConversation: () => convo,
    setConversation,
    messageReactions: new ReactionsByConversation(),
    reactionUpdates: new Map(),
    rowPatches: new Map(),
    pendingById: new Map(),
    deletedMessages: new Map(),
    editedMessages: new Map(),
    keepPending: async () => {},
    readWatermarkUpdates: {} as ReadWatermarks,
    serverReadWatermarkUpdates: {} as ReadWatermarks,
    historyFloorUpdate: { at: 0 },
    pushPendingMessage,
    dropOwnExcluded: async (m: unknown) => m,
  } as never);
  return { setConversation, pushPendingMessage };
}

describe('the archive replay of a system frame with unparseable data', () => {
  it('is skipped with ONE line and never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await replay('memberAdded', 'Ana a ajoute Bob au groupe');
    expect(out.pushPendingMessage).not.toHaveBeenCalled();
    expect(out.setConversation).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('unparseable data');
    warn.mockRestore();
  });
});
