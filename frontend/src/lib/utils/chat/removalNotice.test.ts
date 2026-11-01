// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerInstant } from '$lib/mls-client/serverInstant';
import type { Conversation } from '$lib/types';
import { recordEviction } from './eviction';
import { drainOwedRemovalNotices, owesRemovalNotice, removalNoticeId } from './removalNotice';

/**
 * A removal line whose instant the server did not answer is OWED, durably, and written when the
 * route answers - at the next evidence, and at the latest after the next session's restore. A
 * retired row receives no further evidence, so "a later evidence asks again" alone lost it for good
 * (review of #2890, MED-1).
 */
const OWNER = 'alice';
const REMOVED_AT = 1_700_000_000_000;
let n = 0;

function world() {
  const groupId = `33333333-3333-4333-8333-${String(++n).padStart(12, '0')}`;
  const conversations = new Map<string, Conversation>([
    [
      groupId,
      {
        id: groupId,
        name: 'G',
        lifecycle: 'active',
        conversationType: 'group',
        messages: [],
      } as unknown as Conversation,
    ],
  ]);
  const written: { id?: string; serverTimestamp?: number }[] = [];
  const addMessageToChat = vi.fn(
    async (
      _s: string,
      content: string,
      key: string,
      o?: { messageId?: string; serverTimestamp?: number }
    ) => {
      written.push({ id: o?.messageId, serverTimestamp: o?.serverTimestamp });
      const row = conversations.get(key)!;
      conversations.set(key, {
        ...row,
        messages: [...row.messages, { isSystem: true, content, id: o?.messageId } as never],
      });
    }
  );
  return { groupId, conversations, written, addMessageToChat };
}

const evict = (
  w: ReturnType<typeof world>,
  ask: () => Promise<ServerInstant>,
  evidence: 'membership-check' | 'inbound-frame' = 'membership-check'
) =>
  recordEviction({
    conversations: w.conversations,
    groupId: w.groupId,
    evidence,
    ownerId: OWNER,
    askRemovedAt: ask,
    addMessageToChat: w.addMessageToChat,
    saveConversation: vi.fn(async () => {}),
    log: () => {},
  });

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('the removal line is owed until the server answers', () => {
  it.each([
    [
      'a route this server does not serve',
      async (): Promise<ServerInstant> => ({ kind: 'unserved' }),
    ],
    [
      'no answer at all',
      async (): Promise<ServerInstant> => {
        throw new Error('network');
      },
    ],
  ])('%s: OWED durably, and the next restore writes it dated', async (_name, unanswered) => {
    const w = world();
    await evict(w, unanswered);
    expect(w.conversations.get(w.groupId)?.lifecycle).toBe('removed');
    expect(w.written).toEqual([]);
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(true);

    await drainOwedRemovalNotices({
      ownerId: OWNER,
      conversations: w.conversations,
      askRemovedAt: async () => ({ kind: 'at', at: REMOVED_AT }),
      addMessageToChat: w.addMessageToChat,
      log: () => {},
    });
    expect(w.written).toEqual([
      { id: removalNoticeId(w.groupId, REMOVED_AT), serverTimestamp: REMOVED_AT },
    ]);
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(false);
  });

  it('the next evidence for the group asks again and writes it', async () => {
    const w = world();
    await evict(w, async () => ({ kind: 'unserved' }));
    await evict(w, async () => ({ kind: 'at', at: REMOVED_AT }), 'inbound-frame');
    expect(w.written).toHaveLength(1);
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(false);
  });

  it('an answer with no instant SETTLES it: refused once, never owed, never asked again', async () => {
    const w = world();
    const ask = vi.fn(async (): Promise<ServerInstant> => ({ kind: 'none' }));
    await evict(w, ask);
    await evict(w, ask, 'inbound-frame');
    expect(w.written).toEqual([]);
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('two evidences landing together write ONE line, under the removal id', async () => {
    const w = world();
    const ask = async (): Promise<ServerInstant> => ({ kind: 'at', at: REMOVED_AT });
    // The thread is not yet showing the first line when the second evidence reads it.
    const writes: Promise<unknown>[] = [evict(w, ask), evict(w, ask, 'inbound-frame')];
    await Promise.all(writes);
    const ids = new Set(w.written.map((x) => x.id));
    expect(ids).toEqual(new Set([removalNoticeId(w.groupId, REMOVED_AT)]));
  });

  it('the drain drops a group re-admitted since, or whose row is gone', async () => {
    const w = world();
    await evict(w, async () => ({ kind: 'unserved' }));
    w.conversations.set(w.groupId, { ...w.conversations.get(w.groupId)!, lifecycle: 'active' });
    const ask = vi.fn(async (): Promise<ServerInstant> => ({ kind: 'at', at: REMOVED_AT }));
    await drainOwedRemovalNotices({
      ownerId: OWNER,
      conversations: w.conversations,
      askRemovedAt: ask,
      addMessageToChat: w.addMessageToChat,
      log: () => {},
    });
    expect(ask).not.toHaveBeenCalled();
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(false);
  });
});
