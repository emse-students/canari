/**
 * The store of mutations whose message is not here yet (`PendingMutation`), the insert-only message
 * write (`saveMessagesIfAbsent`), the compare-and-set every rewrite of a message row goes through
 * (`mergeMessages`, `updateMessage`) and the conversation scope of `getMessagesByIds` - on BOTH
 * backends: IndexedDB through `fake-indexeddb`, SQLite through `SqliteStorage.init` run for real
 * against `node:sqlite`. And the upgrade of a database each backend's previous build left behind
 * (IndexedDB v12, SQLite v17).
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import { SCHEMA_VERSION } from './sqliteMigrations';
import type { IStorage, PendingMutation, StoredMessage } from './types';
import { encryptData } from '../encryption';
import { mergeStoredMessage, toMessagePayload } from './messagePayload';
import { replayedMutationsOnto, replayedStoredRow } from '$lib/utils/chat/history';
import {
  settleWalkedMutations,
  type DeferredMutation,
  type PendingMutationDeps,
} from '$lib/utils/chat/pendingMutationStore';
import {
  PENDING_MUTATIONS_PER_CONVERSATION,
  PENDING_MUTATIONS_PER_SENDER,
} from '$lib/utils/chat/pendingMutations';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const ROOMY = { perSender: 100, perConversation: 1000 };
let n = 0;

/** A real `node:sqlite` engine behind the plugin's `execute`/`select`. */
function sqliteEngine() {
  // Reached through `process.getBuiltinModule`, never an `import`: the test environment is a
  // browser one, and Vite refuses to bundle a Node built-in named in an import.
  const engine = new (process.getBuiltinModule('node:sqlite').DatabaseSync)(':memory:');
  /** The plugin binds `$n`; `?n` is the same positional parameter for `node:sqlite`. */
  const positional = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');
  const db = {
    execute: async (sql: string, params: unknown[] = []) => {
      const result = engine.prepare(positional(sql)).run(...(params as never[]));
      return { rowsAffected: Number(result.changes) };
    },
    select: async (sql: string, params: unknown[] = []) =>
      engine.prepare(positional(sql)).all(...(params as never[])),
    close: async () => undefined,
  };
  return { engine, db };
}

async function sqliteOver(db: unknown): Promise<SqliteStorage> {
  vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
  const storage = new SqliteStorage(`pending-${n++}`);
  await storage.init();
  return storage;
}

/** What a test reads and damages underneath a backend, in its own terms. */
interface Rig {
  storage: IStorage;
  /** Every pending-mutation row as stored, serialised - what a disk image would show. */
  pendingAtRest(): Promise<string>;
  /** Overwrites every pending-mutation row's sealed bytes with bytes that do not open. */
  corruptPending(): Promise<void>;
  /** The revision a message row stands at. */
  revisionOf(id: string): Promise<number>;
  /** Stores `value` as a message row's timestamp, as an older build or a phone backup did. */
  setTimestamp(id: string, value: unknown): Promise<void>;
  /** Every pending-mutation row exactly as stored. */
  pendingRows(): Promise<any[]>;
  /** Writes `rows` back as they were read by {@link pendingRows} - an interrupted move's leftovers. */
  restorePending(rows: any[]): Promise<void>;
}

async function sqliteRig(): Promise<Rig> {
  const { engine, db } = sqliteEngine();
  const storage = await sqliteOver(db);
  return {
    storage,
    pendingAtRest: async () =>
      JSON.stringify(engine.prepare('SELECT * FROM pending_mutations').all()),
    corruptPending: async () => {
      engine.exec(`UPDATE pending_mutations SET cipher_text = '${btoa('not a sealed payload!!')}'`);
    },
    revisionOf: async (id) =>
      Number(
        (engine.prepare('SELECT rev FROM messages WHERE id = ?').get(id) as { rev: number }).rev
      ),
    setTimestamp: async (id, value) => {
      engine.prepare('UPDATE messages SET timestamp = ? WHERE id = ?').run(value as never, id);
    },
    pendingRows: async () => engine.prepare('SELECT * FROM pending_mutations').all(),
    restorePending: async (rows) => {
      for (const row of rows) {
        const cols = Object.keys(row);
        engine
          .prepare(
            `INSERT OR REPLACE INTO pending_mutations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
          )
          .run(...(cols.map((c) => row[c]) as never[]));
      }
    },
  };
}

async function idbRig(): Promise<Rig> {
  const storage = new IndexedDbStorage(`pending-${Date.now()}-${n++}`);
  await storage.init();
  const db = (storage as unknown as { ensureDb(): IDBDatabase }).ensureDb();
  const all = (store: string) =>
    new Promise<any[]>((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const rewrite = (store: string, change: (row: any) => any) =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const req = os.getAll();
      req.onsuccess = () => {
        for (const row of req.result) {
          const next = change(row);
          if (next) os.put(next);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  return {
    storage,
    pendingAtRest: async () =>
      JSON.stringify(await all('pendingMutations'), (_k, v) =>
        v instanceof Uint8Array ? Array.from(v) : v
      ),
    corruptPending: () =>
      rewrite('pendingMutations', (row) => ({
        ...row,
        cipherText: new TextEncoder().encode('not a sealed payload!!'),
      })),
    revisionOf: async (id) => Number((await all('messages')).find((r) => r.id === id)?.rev),
    setTimestamp: (id, value) =>
      rewrite('messages', (row) => (row.id === id ? { ...row, timestamp: value } : null)),
    pendingRows: () => all('pendingMutations'),
    restorePending: (rows) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction('pendingMutations', 'readwrite');
        for (const row of rows) tx.objectStore('pendingMutations').put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  };
}

afterEach(() => {
  vi.doUnmock('@tauri-apps/plugin-sql');
  vi.restoreAllMocks();
});

const backends: Array<[string, () => Promise<Rig>]> = [
  ['IndexedDbStorage', idbRig],
  ['SqliteStorage', sqliteRig],
];

const entry = (over: Partial<PendingMutation> = {}): PendingMutation => ({
  conversationId: 'conv',
  messageId: 'm1',
  sender: 'alice',
  kind: 'delete',
  slot: '',
  rank: 0,
  at: 1_000,
  ...over,
});

const body = (id: string, content = 'the body', conversationId = 'conv'): StoredMessage => ({
  id,
  conversationId,
  senderId: 'alice',
  content,
  timestamp: 1_000,
});

/**
 * Makes `storage`'s NEXT compare-and-set read be followed, before its write, by `meanwhile` - the
 * write of another writer landing between the read and the write, exactly where the old
 * read-then-write lost it. Deterministic: the hook runs after the read resolved, before it returns.
 */
function writeBetweenReadAndWrite(storage: IStorage, meanwhile: () => Promise<unknown>): void {
  const target = storage as unknown as {
    readRows: (...args: unknown[]) => Promise<unknown>;
  };
  const read = target.readRows.bind(storage);
  let fired = false;
  target.readRows = async (...args: unknown[]) => {
    const out = await read(...args);
    if (!fired) {
      fired = true;
      await meanwhile();
    }
    return out;
  };
}

describe.each(backends)('%s - pending mutations', (_name, rig) => {
  it('keeps an entry sealed, its key TAGGED, and reads it back by message id, and only those asked', async () => {
    const { storage, pendingAtRest } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await storage.putPendingMutation(
      entry({ kind: 'edit', rank: 5, text: 'secret edit' }),
      ROOMY,
      KEY
    );
    await storage.putPendingMutation(
      entry({ messageId: 'm2', sender: 'bob-the-reactor', kind: 'reaction', slot: '🦜' }),
      ROOMY,
      KEY
    );

    const read = await storage.getPendingMutations('conv', ['m1'], KEY);
    expect(read).toEqual({
      entries: [entry({ kind: 'edit', rank: 5, text: 'secret edit' })],
      removedUnreadable: 0,
    });
    expect((await storage.getPendingMutations('other', ['m1'], KEY)).entries).toEqual([]);
    // Nothing at rest names who reacted with what to which message.
    const disk = await pendingAtRest();
    for (const clear of ['bob-the-reactor', '🦜', 'secret edit', '"m2"', '"alice"']) {
      expect(disk).not.toContain(clear);
    }
  });

  it('needs no conversation row - an entry may come before the conversation reaches the store', async () => {
    const { storage } = await rig();
    const write = await storage.putPendingMutation(entry(), ROOMY, KEY);
    expect(write).toEqual({ written: true, kept: true, evicted: 0 });
  });

  it('keeps the larger rank under one key, the first on a tie - decided in the write', async () => {
    const { storage } = await rig();
    const edit = (rank: number, text: string) => entry({ kind: 'edit', rank, text });
    expect((await storage.putPendingMutation(edit(5, 'five'), ROOMY, KEY)).written).toBe(true);
    expect((await storage.putPendingMutation(edit(3, 'three'), ROOMY, KEY)).written).toBe(false);
    expect((await storage.putPendingMutation(edit(5, 'tie'), ROOMY, KEY)).written).toBe(false);
    expect((await storage.putPendingMutation(edit(9, 'nine'), ROOMY, KEY)).written).toBe(true);
    const read = await storage.getPendingMutations('conv', ['m1'], KEY);
    expect(read.entries.map((e) => e.text)).toEqual(['nine']);
  });

  it('keeps one entry per sender and kind, so another sender never displaces the author', async () => {
    const { storage } = await rig();
    await storage.putPendingMutation(entry({ sender: 'mallory' }), ROOMY, KEY);
    await storage.putPendingMutation(entry({ sender: 'alice' }), ROOMY, KEY);
    await storage.putPendingMutation(
      entry({ sender: 'mallory', kind: 'edit', rank: 9e15, text: 'far future' }),
      ROOMY,
      KEY
    );
    await storage.putPendingMutation(
      entry({ sender: 'alice', kind: 'edit', rank: 5, text: 'mine' }),
      ROOMY,
      KEY
    );
    const read = await storage.getPendingMutations('conv', ['m1'], KEY);
    expect(read.entries).toHaveLength(4);
  });

  it("a FLOOD by one sender evicts only that sender's own entries, never another member's deletion", async () => {
    const { storage } = await rig();
    const limits = { perSender: 3, perConversation: 1000 };
    await storage.putPendingMutation(entry({ sender: 'alice', at: 1 }), limits, KEY);
    let evicted = 0;
    for (let i = 0; i < 20; i++) {
      const write = await storage.putPendingMutation(
        entry({ sender: 'mallory', messageId: `x${i}`, at: 100 + i }),
        limits,
        KEY
      );
      evicted += write.evicted;
    }
    expect(evicted).toBe(17);
    expect((await storage.getPendingMutations('conv', ['m1'], KEY)).entries).toEqual([
      entry({ sender: 'alice', at: 1 }),
    ]);
    const flood = Array.from({ length: 20 }, (_, i) => `x${i}`);
    const left = await storage.getPendingMutations('conv', flood, KEY);
    // The sender's three newest stay.
    expect(left.entries.map((e) => e.messageId).sort()).toEqual(['x17', 'x18', 'x19']);
  });

  it('evicts a reaction before a deletion or an edit of the same sender, whatever their age', async () => {
    const { storage } = await rig();
    const limits = { perSender: 2, perConversation: 1000 };
    await storage.putPendingMutation(entry({ messageId: 'old-delete', at: 1 }), limits, KEY);
    await storage.putPendingMutation(
      entry({ messageId: 'new-reaction', kind: 'reaction', slot: '👍', at: 500 }),
      limits,
      KEY
    );
    const third = await storage.putPendingMutation(
      entry({ messageId: 'edit', kind: 'edit', rank: 2, text: 't', at: 100 }),
      limits,
      KEY
    );
    expect(third).toEqual({ written: true, kept: true, evicted: 1 });
    const left = await storage.getPendingMutations(
      'conv',
      ['old-delete', 'new-reaction', 'edit'],
      KEY
    );
    expect(left.entries.map((e) => e.messageId).sort()).toEqual(['edit', 'old-delete']);
  });

  it('says when the write evicted the very entry it wrote - written, not kept', async () => {
    const { storage } = await rig();
    const limits = { perSender: 2, perConversation: 1000 };
    await storage.putPendingMutation(entry({ messageId: 'a', at: 1 }), limits, KEY);
    await storage.putPendingMutation(entry({ messageId: 'b', at: 2 }), limits, KEY);
    const reaction = await storage.putPendingMutation(
      entry({ messageId: 'c', kind: 'reaction', slot: '👍', at: 3 }),
      limits,
      KEY
    );
    expect(reaction).toEqual({ written: true, kept: false, evicted: 1 });
  });

  it('over the conversation bound, the sender holding the most loses its lowest entry', async () => {
    const { storage } = await rig();
    const limits = { perSender: 100, perConversation: 4 };
    await storage.putPendingMutation(entry({ sender: 'alice', at: 1 }), limits, KEY);
    for (let i = 0; i < 4; i++) {
      await storage.putPendingMutation(
        entry({ sender: 'mallory', messageId: `x${i}`, at: 100 + i }),
        limits,
        KEY
      );
    }
    expect((await storage.getPendingMutations('conv', ['m1'], KEY)).entries).toHaveLength(1);
    const left = await storage.getPendingMutations('conv', ['x0', 'x1', 'x2', 'x3'], KEY);
    expect(left.entries.map((e) => e.messageId).sort()).toEqual(['x1', 'x2', 'x3']);
  });

  it('removes an entry only at the rank it was read at', async () => {
    const { storage } = await rig();
    const old = entry({ kind: 'reaction', slot: '👍', rank: 1 });
    await storage.putPendingMutation(old, ROOMY, KEY);
    await storage.putPendingMutation({ ...old, rank: 2, removed: true }, ROOMY, KEY);
    await storage.deletePendingMutations([old], KEY);
    expect((await storage.getPendingMutations('conv', ['m1'], KEY)).entries).toHaveLength(1);
    await storage.deletePendingMutations([{ ...old, rank: 2 }], KEY);
    expect((await storage.getPendingMutations('conv', ['m1'], KEY)).entries).toHaveLength(0);
  });

  it('removes an entry whose bytes no longer open under the key that tagged it, and counts it', async () => {
    const { storage, corruptPending } = await rig();
    await storage.putPendingMutation(entry(), ROOMY, KEY);
    await corruptPending();
    expect(await storage.getPendingMutations('conv', ['m1'], KEY)).toEqual({
      entries: [],
      removedUnreadable: 1,
    });
    // Gone: the next read finds nothing to remove.
    expect(await storage.getPendingMutations('conv', ['m1'], KEY)).toEqual({
      entries: [],
      removedUnreadable: 0,
    });
  });

  it('never finds an entry tagged under another key', async () => {
    const { storage } = await rig();
    await storage.putPendingMutation(entry(), ROOMY, OTHER_KEY);
    expect(await storage.getPendingMutations('conv', ['m1'], KEY)).toEqual({
      entries: [],
      removedUnreadable: 0,
    });
  });

  it('moves every entry to a new device key - re-sealed AND re-tagged - and resumes', async () => {
    const { storage } = await rig();
    await storage.putPendingMutation(entry({ kind: 'edit', rank: 3, text: 'x' }), ROOMY, KEY);
    expect(await storage.resealPendingMutations(KEY, OTHER_KEY)).toEqual({
      resealed: 1,
      alreadyNew: 0,
      unreadable: 0,
    });
    expect((await storage.getPendingMutations('conv', ['m1'], KEY)).entries).toEqual([]);
    expect((await storage.getPendingMutations('conv', ['m1'], OTHER_KEY)).entries).toEqual([
      entry({ kind: 'edit', rank: 3, text: 'x' }),
    ]);
    expect(await storage.resealPendingMutations(KEY, OTHER_KEY)).toEqual({
      resealed: 0,
      alreadyNew: 1,
      unreadable: 0,
    });
  });

  it("tags one sender's entries in two conversations apart - nothing at rest links them", async () => {
    const { storage, pendingRows } = await rig();
    await storage.putPendingMutation(entry({ conversationId: 'conv' }), ROOMY, KEY);
    await storage.putPendingMutation(entry({ conversationId: 'conv-b' }), ROOMY, KEY);

    const rows = await pendingRows();
    const tagsOf = (r: any) => [r.message_tag ?? r.messageTag, r.sender_tag ?? r.senderTag];
    expect(rows).toHaveLength(2);
    const [a, b] = rows.map(tagsOf);
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);
  });

  it('a move interrupted after its new row leaves the old one, and the next run sweeps it', async () => {
    const { storage, pendingRows, restorePending } = await rig();
    await storage.putPendingMutation(entry({ kind: 'edit', rank: 3, text: 'x' }), ROOMY, KEY);
    const before = await pendingRows();
    await storage.resealPendingMutations(KEY, OTHER_KEY);
    // The crash: the new row was written, the old one never deleted.
    await restorePending(before);
    expect(await pendingRows()).toHaveLength(2);

    expect((await storage.resealPendingMutations(KEY, OTHER_KEY)).resealed).toBe(1);

    expect(await pendingRows()).toHaveLength(1);
    expect((await storage.getPendingMutations('conv', ['m1'], OTHER_KEY)).entries).toEqual([
      entry({ kind: 'edit', rank: 3, text: 'x' }),
    ]);
  });

  it('is collected with the messages older than its frame', async () => {
    const { storage } = await rig();
    const now = Date.now();
    await storage.putPendingMutation(
      entry({ messageId: 'old', at: now - 10 * 86_400_000 }),
      ROOMY,
      KEY
    );
    await storage.putPendingMutation(entry({ messageId: 'new', at: now }), ROOMY, KEY);

    await storage.deleteOldMessages(86_400_000);

    const left = await storage.getPendingMutations('conv', ['old', 'new'], KEY);
    expect(left.entries.map((e) => e.messageId)).toEqual(['new']);
  });

  it('goes with its conversation', async () => {
    const { storage } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await storage.putPendingMutation(entry(), ROOMY, KEY);
    await storage.deleteConversation('conv');
    expect((await storage.getPendingMutations('conv', ['m1'], KEY)).entries).toEqual([]);
  });
});

describe.each(backends)('%s - saveMessagesIfAbsent', (_name, rig) => {
  it('writes only where no row stands and names what it wrote', async () => {
    const { storage } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage({ ...body('m1'), isDeleted: true, content: 'deleted' }, KEY);

    const written = await storage.saveMessagesIfAbsent([body('m1'), body('m2')], KEY);

    expect([...written]).toEqual(['m2']);
    expect(await storage.getMessage('m1', KEY)).toMatchObject({ isDeleted: true });
    expect(await storage.getMessage('m2', KEY)).toMatchObject({ content: 'the body' });
  });

  it('never writes over a row this device cannot open', async () => {
    const { storage } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('m1', 'sealed elsewhere'), OTHER_KEY);

    expect((await storage.saveMessagesIfAbsent([body('m1')], KEY)).size).toBe(0);
    expect(await storage.getMessage('m1', OTHER_KEY)).toMatchObject({
      content: 'sealed elsewhere',
    });
  });
});

describe.each(backends)('%s - message rows: scope and compare-and-set', (_name, rig) => {
  async function twoConversations(storage: IStorage) {
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveConversation({ id: 'conv-b', name: 'b', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessages([body('m1'), body('b1', 'in B', 'conv-b')], KEY);
  }

  it('reads a row of another conversation as ABSENT, and says so', async () => {
    const { storage } = await rig();
    await twoConversations(storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const found = await storage.getMessagesByIds('conv', ['m1', 'b1'], KEY);

    expect([...found.rows.keys()]).toEqual(['m1']);
    expect(found.unreadable.size).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toContain('another conversation');
  });

  it('never rewrites a row of another conversation', async () => {
    const { storage } = await rig();
    await twoConversations(storage);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const written = await storage.mergeMessages(
      'conv',
      ['b1'],
      (row) => ({ ...row, content: 'rewritten through A' }),
      KEY
    );

    expect(written.size).toBe(0);
    expect(await storage.getMessage('b1', KEY)).toMatchObject({ content: 'in B' });
  });

  it('raises the revision on every write', async () => {
    const { storage, revisionOf } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('m1'), KEY);
    const first = await revisionOf('m1');
    await storage.saveMessage(body('m1', 'again'), KEY);
    await storage.updateMessage('conv', 'm1', { isEdited: true }, KEY);
    expect(await revisionOf('m1')).toBe(first + 2);
  });

  it('a replay write racing a LIVE DELETE keeps the tombstone (the replay gap)', async () => {
    const { storage } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('m1', 'the secret'), KEY);
    // The live drain stores the author's deletion between the replay's read and its write.
    writeBetweenReadAndWrite(storage, () =>
      storage.updateMessage(
        'conv',
        'm1',
        { isDeleted: true, content: 'deleted', authorship: null },
        KEY
      )
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const merge = vi.fn((current: StoredMessage) =>
      replayedStoredRow(
        { senderId: 'alice', content: 'the secret', timestamp: new Date(1_000) } as never,
        current,
        { id: current.id, conversationId: 'conv', userId: 'me' }
      )
    );

    await storage.mergeMessages('conv', ['m1'], merge, KEY);

    expect(merge).toHaveBeenCalledTimes(2);
    expect(merge.mock.calls[1][0]).toMatchObject({ isDeleted: true });
    expect(await storage.getMessage('m1', KEY)).toMatchObject({ isDeleted: true });
    expect(log.mock.calls.flat().join(' ')).toContain('merged again');
  });

  it("the post-save pass racing a LIVE EDIT keeps the later edit and both members' reactions", async () => {
    const { storage } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('m1', 'v0'), KEY);
    writeBetweenReadAndWrite(storage, () =>
      storage.updateMessage(
        'conv',
        'm1',
        {
          content: 'live v2',
          isEdited: true,
          editedAt: 2_000,
          reactions: [{ userId: 'bob', emoji: '👍', at: 5 }] as never,
        },
        KEY
      )
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await storage.mergeMessages(
      'conv',
      ['m1'],
      (current) =>
        replayedMutationsOnto(current, {
          reactions: [{ userId: 'carol', emoji: '🎉', at: 7 }] as never,
          edit: { by: 'alice', content: 'replayed v1', editedAt: new Date(1_000) },
        }),
      KEY
    );

    const row = await storage.getMessage('m1', KEY);
    expect(row).toMatchObject({ content: 'live v2', editedAt: 2_000 });
    expect(row?.reactions?.map((r) => (r as { userId: string }).userId).sort()).toEqual([
      'bob',
      'carol',
    ]);
  });

  it('a row deleted and stored again is never taken for the one read before (ABA)', async () => {
    const { storage, revisionOf } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('m1', 'first life'), KEY);
    await storage.updateMessage('conv', 'm1', { serverTimestamp: 1 }, KEY);
    await storage.updateMessage('conv', 'm1', { serverTimestamp: 2 }, KEY);
    const readAt = await revisionOf('m1');
    // Between the read and the write: deleted, stored again, and rewritten back to the SAME revision.
    writeBetweenReadAndWrite(storage, async () => {
      await storage.deleteMessage('m1', 'conv');
      await storage.saveMessage(body('m1', 'second life'), KEY);
      for (let i = 0; (await revisionOf('m1')) < readAt && i < 10; i++) {
        await storage.saveMessage(body('m1', 'second life'), KEY);
      }
      expect(await revisionOf('m1')).toBe(readAt);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const merge = vi.fn((current: StoredMessage) => ({ ...current, isEdited: true }));

    await storage.mergeMessages('conv', ['m1'], merge, KEY);

    expect(merge).toHaveBeenCalledTimes(2);
    expect(merge.mock.calls[1][0]).toMatchObject({ content: 'second life' });
    expect(await storage.getMessage('m1', KEY)).toMatchObject({
      content: 'second life',
      isEdited: true,
    });
  });

  it('two updateMessage calls racing each other both land', async () => {
    const { storage } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('m1'), KEY);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await Promise.all([
      storage.updateMessage('conv', 'm1', { serverTimestamp: 42 }, KEY),
      storage.updateMessage('conv', 'm1', { isEdited: true, editedAt: 9 }, KEY),
      storage.updateMessage('conv', 'm1', { mediaPurgedAt: 7 }, KEY),
    ]);

    expect(await storage.getMessage('m1', KEY)).toMatchObject({
      serverTimestamp: 42,
      isEdited: true,
      editedAt: 9,
      mediaPurgedAt: 7,
    });
  });

  it('a merge that changes nothing writes nothing', async () => {
    const { storage, revisionOf } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('m1'), KEY);
    const before = await revisionOf('m1');
    expect((await storage.mergeMessages('conv', ['m1'], () => null, KEY)).size).toBe(0);
    expect(await revisionOf('m1')).toBe(before);
    // And `mergeStoredMessage` is what callers fold a patch with.
    expect(mergeStoredMessage(body('m1'), { isEdited: true })).toMatchObject({ isEdited: true });
  });

  it('reads a window by the same rule on both backends, timestamps stored as text included', async () => {
    const { storage, setTimestamp } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessages(
      [body('old'), body('as-text'), body('unreadable'), { ...body('new'), timestamp: 9_000 }],
      KEY
    );
    await setTimestamp('as-text', '5000');
    await setTimestamp('unreadable', 'not a time');

    const since = await storage.getMessagesSince('conv', 2_000, KEY);

    expect(since.map((m) => [m.id, m.timestamp]).sort()).toEqual([
      ['as-text', 5_000],
      ['new', 9_000],
    ]);
  });
});

describe('IndexedDbStorage - an aborted collection', () => {
  it('rejects when a cursor delete throws and aborts the transaction, never hangs', async () => {
    const { storage } = await idbRig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('old'), KEY);
    vi.spyOn(IDBCursor.prototype, 'delete').mockImplementation(() => {
      throw new DOMException('refused', 'DataError');
    });

    await expect(storage.deleteOldMessages(1)).rejects.toBeTruthy();
  });
});

describe('the upgrade of a database the previous build left', () => {
  it('IndexedDB v12 -> v13 adds the store and keeps every message', async () => {
    const userId = `v12-${Date.now()}-${n++}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`CanariDB_${userId}`, 12);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('byConversation', 'conversationId', { unique: false });
        store.createIndex('byConversationTime', ['conversationId', 'timestamp'], {
          unique: false,
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const row = {
      id: 'm1',
      conversationId: 'conv',
      timestamp: 1_000,
      orderAt: 1_000,
      ...(await encryptData(toMessagePayload(body('m1')), KEY)),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const storage = new IndexedDbStorage(userId);
    await storage.init();

    expect(await storage.getMessage('m1', KEY)).toMatchObject({ content: 'the body' });
    expect((await storage.putPendingMutation(entry(), ROOMY, KEY)).written).toBe(true);
    // A row from before revisions reads at 0, and the compare-and-set takes it from there.
    await storage.updateMessage('conv', 'm1', { isEdited: true }, KEY);
    expect(await storage.getMessage('m1', KEY)).toMatchObject({ isEdited: true });
  });

  it('SQLite v17 -> v18 creates the table, adds `rev`, stamps 18 and keeps every message', async () => {
    const { engine, db } = sqliteEngine();
    const first = await sqliteOver(db);
    await first.saveConversation({ id: 'conv', name: 'c', lifecycle: 'active', updatedAt: 1 });
    await first.saveMessage(body('m1'), KEY);
    // What a v17 build left: no `pending_mutations`, no `messages.rev`, stamped 17.
    engine.exec(
      'DROP TABLE pending_mutations; ALTER TABLE messages DROP COLUMN rev; PRAGMA user_version = 17;'
    );

    const upgraded = await sqliteOver(db);

    expect(SCHEMA_VERSION).toBe(20);
    expect(engine.prepare('PRAGMA user_version').get()).toEqual({ user_version: 20 });
    expect(engine.prepare("SELECT rev FROM messages WHERE id = 'm1'").get()).toEqual({ rev: 0 });
    expect(await upgraded.getMessage('m1', KEY)).toMatchObject({ content: 'the body' });
    expect((await upgraded.putPendingMutation(entry(), ROOMY, KEY)).written).toBe(true);
    await upgraded.updateMessage('conv', 'm1', { isEdited: true }, KEY);
    expect(engine.prepare("SELECT rev FROM messages WHERE id = 'm1'").get()).toEqual({ rev: 1 });
  });
});

describe.each(backends)('%s - a replay settles what it deferred', (_name, rig) => {
  it('loses none of a sign-in flood on buffered bodies - over the per-sender AND per-conversation bounds', async () => {
    const { storage, pendingRows } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    const total = PENDING_MUTATIONS_PER_CONVERSATION + 100;
    const byAlice = PENDING_MUTATIONS_PER_SENDER + 50;
    // The walk buffered every body and wrote them at its end, as the replay's flush does.
    await storage.saveMessages(
      Array.from({ length: total }, (_, i) => body(`m${i}`)),
      KEY
    );
    const walked: DeferredMutation[] = Array.from({ length: total }, (_, i) => ({
      entry: {
        conversationId: 'conv',
        messageId: `m${i}`,
        sender: i < byAlice ? 'alice' : `member-${i % 7}`,
        kind: 'reaction',
        slot: '👍',
        rank: 10 + i,
      },
      frameAt: 5_000 + i,
    }));
    // And one whose message this walk never saw: that one, and only that one, is parked.
    walked.push({
      entry: {
        conversationId: 'conv',
        messageId: 'not-here',
        sender: 'alice',
        kind: 'delete',
        slot: '',
        rank: 0,
      },
      frameAt: 9_000,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = vi.fn();
    const deps: PendingMutationDeps = {
      storage,
      deviceKey: () => KEY,
      conversations: new Map(),
      messageReactions: new Map(),
      log,
    } as unknown as PendingMutationDeps;

    await settleWalkedMutations(deps, 'conv', walked);

    const rows = await storage.getMessagesByIds(
      'conv',
      Array.from({ length: total }, (_, i) => `m${i}`),
      KEY
    );
    const withReaction = [...rows.rows.values()].filter((r) =>
      (r.reactions ?? []).some((x) => (x as { emoji: string }).emoji === '👍')
    );
    expect(withReaction).toHaveLength(total);
    expect(await pendingRows()).toHaveLength(1);
    const said = log.mock.calls.map((c) => String(c[0]));
    expect(said.filter((l) => l.includes('arrived before its message'))).toHaveLength(1);
    // Over a thousand real seals and opens, twice: a time bound on the size, never on the outcome.
  }, 120_000);
});

describe.each(backends)('%s - a replay never drops what it cannot settle', (_name, rig) => {
  it('parks a deferred mutation whose target row this device cannot open', async () => {
    const { storage, pendingRows } = await rig();
    await storage.saveConversation({ id: 'conv', name: 'a', lifecycle: 'active', updatedAt: 1 });
    await storage.saveMessage(body('sealed'), OTHER_KEY);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = {
      storage,
      deviceKey: () => KEY,
      conversations: new Map(),
      messageReactions: new Map(),
      log: vi.fn(),
    } as unknown as PendingMutationDeps;

    await settleWalkedMutations(deps, 'conv', [
      {
        entry: {
          conversationId: 'conv',
          messageId: 'sealed',
          sender: 'alice',
          kind: 'delete',
          slot: '',
          rank: 0,
        },
        frameAt: 5_000,
      },
    ]);

    expect(await pendingRows()).toHaveLength(1);
    expect((await storage.getMessage('sealed', OTHER_KEY))?.isDeleted).toBeFalsy();
  });
});
