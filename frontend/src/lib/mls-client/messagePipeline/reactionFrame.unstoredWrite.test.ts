/**
 * A REACTION WHOSE WRITE ONTO ITS STORED ROW FAILS IS KEPT, NEVER ONLY LOGGED (rows before ratchet,
 * review of #3851). The frame is acknowledged and its generation spent once the handler returns, so
 * a reaction shown and not written was lost at the next reload. It is parked as a pending mutation,
 * which the next look writes onto its row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

const keepPendingMutation = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('$lib/utils/chat/pendingMutationStore', () => ({ keepPendingMutation }));

import { applyReactionFrame } from './reactionFrame';

const CONVO = 'conversation-key';

function deps(mergeMessages: ReturnType<typeof vi.fn>) {
  return {
    storage: {
      getMessagesByIds: vi.fn(async () => ({
        rows: new Map([['m1', { senderId: 'author', reactions: [] }]]),
        unreadable: new Set(),
      })),
      mergeMessages,
    },
    deviceKey: () => 'device-key',
    conversations: new SvelteMap(),
    messageReactions: new ReactionsByConversation(),
    log: vi.fn(),
  } as never;
}

describe('a reaction onto a stored row', () => {
  beforeEach(() => {
    keepPendingMutation.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('is written onto the row, and nothing is kept, when the write lands', async () => {
    const mergeMessages = vi.fn().mockResolvedValue(new Set(['m1']));

    const outcome = await applyReactionFrame(
      deps(mergeMessages),
      CONVO,
      'peer',
      { messageId: 'm1', emoji: '+1', at: 10 },
      undefined,
      1_000
    );

    expect(outcome.changed).toBe(true);
    expect(mergeMessages).toHaveBeenCalledTimes(1);
    expect(keepPendingMutation).not.toHaveBeenCalled();
  });

  it('is KEPT as a pending mutation when the write fails, said at error', async () => {
    const mergeMessages = vi.fn().mockRejectedValue(new Error('QuotaExceededError'));

    await applyReactionFrame(
      deps(mergeMessages),
      CONVO,
      'peer',
      { messageId: 'm1', emoji: '+1', at: 10 },
      undefined,
      1_000
    );

    expect(keepPendingMutation).toHaveBeenCalledTimes(1);
    expect(keepPendingMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: CONVO,
        messageId: 'm1',
        kind: 'reaction',
        slot: '+1',
        rank: 10,
      }),
      1_000,
      'could not be written onto its stored row'
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('kept as a pending mutation'),
      expect.any(Error)
    );
  });
});
