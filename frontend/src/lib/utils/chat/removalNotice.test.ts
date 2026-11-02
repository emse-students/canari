// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerInstant } from '$lib/mls-client/serverInstant';
import type { Conversation } from '$lib/types';
import { recordEviction } from './eviction';
import {
  drainOwedRemovalNotices,
  forgetRemovalNotices,
  owesRemovalNotice,
  removalNoticeId,
  writeRemovalNotice,
} from './removalNotice';

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
  forgetRemovalNotices();
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
      isCurrent: () => true,
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

  it('two evidences landing together write ONE line, even with different instants', async () => {
    const w = world();
    // The Remove commit's delivery and the announcement's are two instants of one removal.
    const writes: Promise<unknown>[] = [
      evict(w, async () => ({ kind: 'at', at: REMOVED_AT })),
      evict(w, async () => ({ kind: 'at', at: REMOVED_AT + 40 }), 'inbound-frame'),
    ];
    await Promise.all(writes);
    // Whichever evidence writes first, the second finds the line and writes none.
    expect(w.written).toHaveLength(1);
  });

  /** The 2026-09-22 rule kept across the ask (review of #2890, MED-B). */
  it('a removal undone WHILE its date is asked writes no line, and is settled', async () => {
    const w = world();
    const readmit = () =>
      w.conversations.set(w.groupId, { ...w.conversations.get(w.groupId)!, lifecycle: 'active' });
    await evict(w, async () => {
      readmit(); // a Welcome installs during the await
      return { kind: 'at', at: REMOVED_AT };
    });
    expect(w.written).toEqual([]);
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(false);
  });

  it('the drain: a removal undone while its date is asked writes no line', async () => {
    const w = world();
    await evict(w, async () => ({ kind: 'unserved' }));
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(true);
    await drainOwedRemovalNotices({
      ownerId: OWNER,
      conversations: w.conversations,
      askRemovedAt: async () => {
        w.conversations.set(w.groupId, {
          ...w.conversations.get(w.groupId)!,
          lifecycle: 'active',
        });
        return { kind: 'at', at: REMOVED_AT };
      },
      addMessageToChat: w.addMessageToChat,
      log: () => {},
      isCurrent: () => true,
    });
    expect(w.written).toEqual([]);
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(false);
  });

  it('the drain writes nothing once its session ended, and the line stays owed', async () => {
    const w = world();
    await evict(w, async () => ({ kind: 'unserved' }));
    let current = true;
    await drainOwedRemovalNotices({
      ownerId: OWNER,
      conversations: w.conversations,
      askRemovedAt: async () => {
        current = false; // signed out while the answer travelled
        return { kind: 'at', at: REMOVED_AT };
      },
      addMessageToChat: w.addMessageToChat,
      log: () => {},
      isCurrent: () => current,
    });
    expect(w.written).toEqual([]);
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(true);
  });

  /** Review of #2890, MED-A: an answered "no instant" is per account and per session, and said. */
  it('an answered "no instant" silences only this account, only this session, and says so', async () => {
    const w = world();
    const log = vi.fn();
    await evict(w, async () => ({ kind: 'none' }));
    const again = () =>
      recordEviction({
        conversations: w.conversations,
        groupId: w.groupId,
        evidence: 'inbound-frame',
        ownerId: OWNER,
        askRemovedAt: async () => ({ kind: 'at', at: REMOVED_AT }),
        addMessageToChat: w.addMessageToChat,
        saveConversation: vi.fn(async () => {}),
        log,
      });
    await again();
    expect(w.written).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('removal notice not asked'));
    // Another account on this install asks for itself.
    await recordEviction({
      conversations: w.conversations,
      groupId: w.groupId,
      evidence: 'inbound-frame',
      ownerId: 'bob',
      askRemovedAt: async () => ({ kind: 'at', at: REMOVED_AT }),
      addMessageToChat: w.addMessageToChat,
      saveConversation: vi.fn(async () => {}),
      log: () => {},
    });
    expect(w.written).toHaveLength(1);
  });

  it('the next session asks afresh after an answered "no instant"', async () => {
    const w = world();
    await evict(w, async () => ({ kind: 'none' }));
    forgetRemovalNotices(); // the sign-out
    await evict(w, async () => ({ kind: 'at', at: REMOVED_AT }), 'inbound-frame');
    expect(w.written).toHaveLength(1);
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
      isCurrent: () => true,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(false);
  });

  /** Review of #2890, verification LOW-1: a throw must not reject every write queued behind it. */
  it('a write that THROWS does not take the next one with it', async () => {
    const w = world();
    // Retired first, so both writes find a removed row.
    await evict(w, async () => ({ kind: 'unserved' }));
    const throwing = writeRemovalNotice({
      conversations: w.conversations,
      key: w.groupId,
      groupId: w.groupId,
      ownerId: OWNER,
      askRemovedAt: async () => {
        throw new Error('network');
      },
      addMessageToChat: w.addMessageToChat,
      speak: true,
      label: 'test',
      // Throws inside the critical section, outside every catch of its own.
      log: () => {},
      isCurrent: () => {
        throw new Error('boom');
      },
    });
    const next = writeRemovalNotice({
      conversations: w.conversations,
      key: w.groupId,
      groupId: w.groupId,
      ownerId: OWNER,
      removedAt: REMOVED_AT,
      addMessageToChat: w.addMessageToChat,
      speak: true,
      label: 'test',
      log: () => {},
    });
    await expect(throwing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('written');
    expect(w.written).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('removal notice write THREW')
    );
  });

  /** Verification LOW-2: a live path passes no session check, and a sign-out clears the map. */
  it("a sign-out during a live evidence's ask keeps the line owed", async () => {
    const w = world();
    await evict(w, async () => ({ kind: 'unserved' }));
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(true);
    await evict(
      w,
      async () => {
        w.conversations.clear(); // the sign-out clears the map while the answer travels
        return { kind: 'at', at: REMOVED_AT };
      },
      'inbound-frame'
    );
    expect(w.written).toEqual([]);
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(true);
  });

  /** Verification LOW-3: an earlier removal's line does not stand for a later removal's. */
  it('removed, re-admitted, removed again: a second line is written', async () => {
    const w = world();
    await evict(w, async () => ({ kind: 'at', at: REMOVED_AT }));
    // A re-admission that left the first line in place.
    w.conversations.set(w.groupId, { ...w.conversations.get(w.groupId)!, lifecycle: 'active' });
    await evict(w, async () => ({ kind: 'at', at: REMOVED_AT + 60_000 }), 'inbound-frame');
    expect(w.written.map((x) => x.id)).toEqual([
      removalNoticeId(w.groupId, REMOVED_AT),
      removalNoticeId(w.groupId, REMOVED_AT + 60_000),
    ]);
    // And a further evidence of the SECOND removal writes nothing more.
    await evict(w, async () => ({ kind: 'at', at: REMOVED_AT + 60_100 }), 'inbound-frame');
    expect(w.written).toHaveLength(2);
  });

  it('the next session still tells an earlier removal line from an owed one', async () => {
    const w = world();
    await evict(w, async () => ({ kind: 'at', at: REMOVED_AT }));
    w.conversations.set(w.groupId, { ...w.conversations.get(w.groupId)!, lifecycle: 'active' });
    await evict(w, async () => ({ kind: 'unserved' }), 'inbound-frame');
    forgetRemovalNotices(); // a new session
    await drainOwedRemovalNotices({
      ownerId: OWNER,
      conversations: w.conversations,
      askRemovedAt: async () => ({ kind: 'at', at: REMOVED_AT + 60_000 }),
      addMessageToChat: w.addMessageToChat,
      log: () => {},
      isCurrent: () => true,
    });
    expect(w.written).toHaveLength(2);
    expect(owesRemovalNotice(OWNER, w.groupId)).toBe(false);
  });
});
