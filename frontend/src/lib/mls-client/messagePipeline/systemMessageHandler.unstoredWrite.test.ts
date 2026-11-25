/**
 * AN EDIT OR A TOMBSTONE WHOSE WRITE ONTO ITS STORED ROW FAILS IS KEPT, NEVER ONLY LOGGED (rows
 * before ratchet, second review of #3851). The frame is acknowledged and its generation spent once the
 * handler returns, so an edit or a deletion shown and not written came back at the next reload. Each
 * is parked as a pending mutation, which the next look writes onto its row - as a reaction is
 * (`reactionFrame.unstoredWrite.test.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

const keepPendingMutation = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('$lib/utils/chat/pendingMutationStore', async (original) => ({
  ...(await original<typeof import('$lib/utils/chat/pendingMutationStore')>()),
  keepPendingMutation,
}));

import { handleSystemEvent } from './systemMessageHandler';
import { mkTextEnvelope, serializeEnvelope } from '$lib/envelope';

function makeCtx(mergeMessages: ReturnType<typeof vi.fn>) {
  const row = {
    id: 'm1',
    conversationId: 'g1',
    senderId: 'peer',
    content: serializeEnvelope(mkTextEnvelope('original')),
    timestamp: 1_700_000_000_000,
  };
  const conversations = new Map<string, any>([
    [
      'g1',
      { id: 'g1', unreadCount: 0, messages: [{ ...row, timestamp: new Date(row.timestamp) }] },
    ],
  ]);
  return {
    mlsService: {},
    storage: {
      mergeMessages,
      getMessagesByIds: vi.fn(async () => ({
        rows: new Map([['m1', row]]),
        unreadable: new Set(),
      })),
    },
    userId: 'me',
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new ReactionsByConversation(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: {},
    convoKey: 'g1',
    senderNorm: 'peer',
    persistMlsStateNow: vi.fn(),
  };
}

describe('an edit or a deletion onto a stored row whose write fails', () => {
  beforeEach(() => {
    keepPendingMutation.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('an EDIT is kept as a pending mutation, said at error', async () => {
    const ctx = makeCtx(vi.fn().mockRejectedValue(new DOMException('full', 'QuotaExceededError')));

    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'edited', editedAt: 2000 },
      ctx as any
    );

    expect(keepPendingMutation).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ messageId: 'm1', kind: 'edit', text: 'edited', rank: 2000 }),
      undefined,
      'could not be written onto its stored row'
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('kept as a pending mutation'),
      expect.anything()
    );
  });

  it('a DELETION is kept as a pending mutation, said at error', async () => {
    const ctx = makeCtx(vi.fn().mockRejectedValue(new DOMException('full', 'QuotaExceededError')));

    await handleSystemEvent('delete_message', { messageId: 'm1' }, ctx as any);

    expect(keepPendingMutation).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ messageId: 'm1', kind: 'delete' }),
      undefined,
      'could not be written onto its stored row'
    );
  });

  it('nothing is kept when the write lands', async () => {
    const ctx = makeCtx(vi.fn().mockResolvedValue(new Set(['m1'])));

    await handleSystemEvent(
      'edit_message',
      { messageId: 'm1', newContent: 'edited', editedAt: 2000 },
      ctx as any
    );

    expect(keepPendingMutation).not.toHaveBeenCalled();
  });
});
