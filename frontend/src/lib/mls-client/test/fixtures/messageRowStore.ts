/**
 * A message store keyed by message id, each row naming its conversation - the IndexedDB shape the
 * 1:1 re-key and the boot merge move rows across. Its scoped read records a row of another
 * conversation where the real one warns, so a test can assert that never happens; a row marked
 * `unreadable` stands in the store but does not open, as one sealed under another device key.
 * Mutations waiting for their message (`pending`) are kept the way the real store keeps them: one
 * entry per conversation, message, sender, kind and slot, the higher rank winning.
 */
import { vi } from 'vitest';
import type { ConversationMeta, StoredMessage } from '$lib/db';
import type { PendingMutation, StoredMessageMerge } from '$lib/db/types';

const pendingKey = (e: PendingMutation) =>
  [e.conversationId, e.messageId, e.sender, e.kind, e.slot].join('|');

/** A stored row, plus whether this device's key opens it. */
export type TestRow = StoredMessage & { unreadable?: boolean };

/** Builds the store; `failSave` makes every whole-row write reject. */
export function messageRowStore(rows: TestRow[], opts: { failSave?: boolean } = {}) {
  const byId = new Map<string, TestRow>(rows.map((r) => [r.id, { ...r }]));
  const conversations = new Map<string, ConversationMeta>();
  const foreign: string[] = [];
  const pending = new Map<string, PendingMutation>();
  const store = {
    byId,
    conversations,
    foreign,
    pending,
    mergeMessages: vi.fn(
      async (conv: string, ids: readonly string[], merge: StoredMessageMerge) => {
        const written = new Set<string>();
        for (const id of ids) {
          const row = byId.get(id);
          if (!row || row.conversationId !== conv || row.unreadable) continue;
          const next = merge(row);
          if (!next) continue;
          byId.set(id, { ...next });
          written.add(id);
        }
        return written;
      }
    ),
    putPendingMutation: vi.fn(async (entry: PendingMutation) => {
      const key = pendingKey(entry);
      const held = pending.get(key);
      if (held && held.rank >= entry.rank && held.kind !== 'delete') {
        return { written: false, kept: true, evicted: 0 };
      }
      pending.set(key, { ...entry });
      return { written: true, kept: true, evicted: 0 };
    }),
    getPendingMutations: vi.fn(async (conv: string, ids: readonly string[]) => ({
      entries: [...pending.values()].filter(
        (e) => e.conversationId === conv && ids.includes(e.messageId)
      ),
      removedUnreadable: 0,
    })),
    deletePendingMutations: vi.fn(async (entries: readonly PendingMutation[]) => {
      for (const e of entries) {
        const key = pendingKey(e);
        if (pending.get(key)?.rank === e.rank) pending.delete(key);
      }
    }),
    getMessages: vi.fn(async (conv: string) =>
      [...byId.values()]
        .filter((r) => r.conversationId === conv && !r.unreadable)
        .map(({ unreadable: _u, ...r }) => r as StoredMessage)
    ),
    getMessagesByIds: vi.fn(async (conv: string, ids: readonly string[]) => {
      const found = new Map<string, StoredMessage>();
      const unreadable = new Set<string>();
      for (const id of ids) {
        const row = byId.get(id);
        if (!row) continue;
        if (row.conversationId !== conv) foreign.push(id);
        else if (row.unreadable) unreadable.add(id);
        else found.set(id, row);
      }
      return { rows: found, unreadable };
    }),
    countMessages: vi.fn(
      async (conv: string) => [...byId.values()].filter((r) => r.conversationId === conv).length
    ),
    saveMessages: vi.fn(async (msgs: StoredMessage[]) => {
      if (opts.failSave) throw new Error('store refuses writes');
      for (const m of msgs) byId.set(m.id, { ...m });
    }),
    saveMessagesIfAbsent: vi.fn(async (msgs: StoredMessage[]) => {
      const written = new Set<string>();
      for (const m of msgs) {
        if (byId.has(m.id)) continue;
        byId.set(m.id, { ...m });
        written.add(m.id);
      }
      return written;
    }),
    saveConversation: vi.fn(async (meta: ConversationMeta) => {
      conversations.set(meta.id, meta);
    }),
    getConversation: vi.fn(async (id: string) => conversations.get(id) ?? null),
    deleteConversation: vi.fn(async (id: string) => {
      conversations.delete(id);
      for (const [key, row] of byId) if (row.conversationId === id) byId.delete(key);
    }),
  };
  return store;
}

/** A readable stored row of `conversationId`, its body naming its id. */
export function storedRow(
  id: string,
  conversationId: string,
  extra: Partial<TestRow> = {}
): TestRow {
  return {
    id,
    conversationId,
    senderId: 'peer-user',
    content: `body of ${id}`,
    timestamp: 1000,
    ...extra,
  } as TestRow;
}

/** Each row's conversation, by id - what the move tests compare. */
export function placement(store: ReturnType<typeof messageRowStore>): Record<string, string> {
  return Object.fromEntries([...store.byId.values()].map((r) => [r.id, r.conversationId]));
}
