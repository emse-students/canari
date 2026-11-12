/**
 * A message store keyed by message id, each row naming its conversation - the IndexedDB shape the
 * 1:1 re-key and the boot merge move rows across. Its scoped read records a row of another
 * conversation where the real one warns, so a test can assert that never happens; a row marked
 * `unreadable` stands in the store but does not open, as one sealed under another device key.
 */
import { vi } from 'vitest';
import type { ConversationMeta, StoredMessage } from '$lib/db';

/** A stored row, plus whether this device's key opens it. */
export type TestRow = StoredMessage & { unreadable?: boolean };

/** Builds the store; `failSave` makes every whole-row write reject. */
export function messageRowStore(rows: TestRow[], opts: { failSave?: boolean } = {}) {
  const byId = new Map<string, TestRow>(rows.map((r) => [r.id, { ...r }]));
  const conversations = new Map<string, ConversationMeta>();
  const foreign: string[] = [];
  const store = {
    byId,
    conversations,
    foreign,
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
