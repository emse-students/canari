/**
 * A STORED MESSAGE IS KEYED BY ITS CONVERSATION AND ITS ID (SQLite v23, IndexedDB v15), on BOTH
 * backends: IndexedDB through `fake-indexeddb`, SQLite through `SqliteStorage.init` run for real
 * against `node:sqlite`. A message id is chosen by the frame that carries it, so the same id may name
 * a row in two conversations - each keeps its own, through a reload, and a write, an update or a
 * delete in one never reaches the other. A row changes conversation only through `moveMessages`.
 * And the migration of a store the previous build left keeps every row, even when it is interrupted
 * and run again.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import { messageRekeySteps, MESSAGES_REKEY_STAGING, SCHEMA_VERSION } from './sqliteMigrations';
import type { IStorage, StoredMessage } from './types';
import { encryptData } from '../encryption';
import { toMessagePayload } from './messagePayload';
import { resealDeviceKeyStores } from '$lib/utils/chat/pinChange';
import { ownStoredMessage } from '$lib/utils/chat/ownStoredMessage';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NEW_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
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

/** Opens a `SqliteStorage` over `db` - the same file again is a reload. */
async function sqliteOver(db: unknown): Promise<SqliteStorage> {
  vi.doMock('@tauri-apps/plugin-sql', () => ({ default: { load: async () => db } }));
  const storage = new SqliteStorage(`msgkey-${n++}`);
  await storage.init();
  return storage;
}

/** A backend, and how to open the SAME store again (a reload). */
interface Rig {
  storage: IStorage;
  reload(): Promise<IStorage>;
}

async function sqliteRig(): Promise<Rig> {
  const { db } = sqliteEngine();
  return { storage: await sqliteOver(db), reload: () => sqliteOver(db) };
}

async function idbRig(): Promise<Rig> {
  const userId = `msgkey-${Date.now()}-${n++}`;
  const storage = new IndexedDbStorage(userId);
  await storage.init();
  return {
    storage,
    reload: async () => {
      await storage.close();
      const again = new IndexedDbStorage(userId);
      await again.init();
      return again;
    },
  };
}

const backends: Array<[string, () => Promise<Rig>]> = [
  ['IndexedDbStorage', idbRig],
  ['SqliteStorage', sqliteRig],
];

afterEach(() => {
  vi.doUnmock('@tauri-apps/plugin-sql');
  vi.restoreAllMocks();
});

const A = 'conversation-a';
const B = 'conversation-b';

const row = (
  conversationId: string,
  content: string,
  extra: Partial<StoredMessage> = {}
): StoredMessage => ({
  id: 'shared-id',
  conversationId,
  senderId: 'alice',
  content,
  timestamp: 1_000,
  ...extra,
});

async function twoConversations(storage: IStorage) {
  await storage.saveConversation({ id: A, name: 'a', lifecycle: 'active', updatedAt: 1 });
  await storage.saveConversation({ id: B, name: 'b', lifecycle: 'active', updatedAt: 1 });
}

describe.each(backends)('%s - one message id in two conversations', (_name, open) => {
  it('both store, both read back after a reload', async () => {
    const { storage, reload } = await open();
    await twoConversations(storage);
    await storage.saveMessages([row(A, 'in A')], KEY);

    // THE INGEST'S WRITE: an arriving message whose id another conversation holds is written.
    const written = await storage.saveMessagesIfAbsent([row(B, 'in B')], KEY);
    expect([...written]).toEqual(['shared-id']);

    const again = await reload();
    expect(await again.getMessage(A, 'shared-id', KEY)).toMatchObject({ content: 'in A' });
    expect(await again.getMessage(B, 'shared-id', KEY)).toMatchObject({ content: 'in B' });
    expect((await again.getMessages(B, KEY)).map((m) => m.content)).toEqual(['in B']);
    expect((await again.getMessagesPage(A, KEY, 10)).map((m) => m.content)).toEqual(['in A']);
    expect((await again.findMessageConversations('shared-id')).sort()).toEqual([A, B]);
    expect(await again.countMessages(A)).toBe(1);
    expect(await again.countMessages(B)).toBe(1);
  });

  it('a held key is still an answer: the same id in the SAME conversation is not written', async () => {
    const { storage } = await open();
    await twoConversations(storage);
    await storage.saveMessages([row(A, 'first')], KEY);

    expect((await storage.saveMessagesIfAbsent([row(A, 'second')], KEY)).size).toBe(0);
    expect(await storage.getMessage(A, 'shared-id', KEY)).toMatchObject({ content: 'first' });
  });

  it('refuses a batch of several conversations - it answers in ids', async () => {
    const { storage } = await open();
    await twoConversations(storage);
    await expect(storage.saveMessagesIfAbsent([row(A, 'a'), row(B, 'b')], KEY)).rejects.toThrow(
      'one conversation per call'
    );
  });

  it('a save in one never moves nor rewrites the other', async () => {
    const { storage } = await open();
    await twoConversations(storage);
    await storage.saveMessages([row(A, 'in A')], KEY);
    await storage.saveMessages([row(B, 'in B')], KEY);
    await storage.saveMessages([row(B, 'in B, saved again')], KEY);

    expect(await storage.getMessage(A, 'shared-id', KEY)).toMatchObject({ content: 'in A' });
    expect(await storage.getMessage(B, 'shared-id', KEY)).toMatchObject({
      content: 'in B, saved again',
    });
  });

  it('an update or a merge in one leaves the other as it is', async () => {
    const { storage, reload } = await open();
    await twoConversations(storage);
    await storage.saveMessages([row(A, 'in A')], KEY);
    await storage.saveMessages([row(B, 'in B')], KEY);

    await storage.updateMessage(A, 'shared-id', { isEdited: true, content: 'edited in A' }, KEY);
    const merged = await storage.mergeMessages(
      B,
      ['shared-id'],
      (current) => ({ ...current, reactions: [{ userId: 'bob', emoji: 'x', at: 5 }] }),
      KEY
    );
    expect([...merged]).toEqual(['shared-id']);

    const again = await reload();
    expect(await again.getMessage(A, 'shared-id', KEY)).toMatchObject({
      content: 'edited in A',
      isEdited: true,
    });
    expect((await again.getMessage(A, 'shared-id', KEY))?.reactions ?? []).toEqual([]);
    const b = await again.getMessage(B, 'shared-id', KEY);
    expect(b).toMatchObject({ content: 'in B' });
    expect(b?.isEdited).toBeFalsy();
    expect(b?.reactions?.map((r) => r.emoji)).toEqual(['x']);
  });

  it('a delete in one leaves the other', async () => {
    const { storage, reload } = await open();
    await twoConversations(storage);
    await storage.saveMessages([row(A, 'in A')], KEY);
    await storage.saveMessages([row(B, 'in B')], KEY);

    await storage.deleteMessage(A, 'shared-id');

    const again = await reload();
    expect(await again.getMessage(A, 'shared-id', KEY)).toBeNull();
    expect(await again.getMessage(B, 'shared-id', KEY)).toMatchObject({ content: 'in B' });
  });

  it('a backup row is imported under its own conversation, next to the other', async () => {
    const { storage } = await open();
    await twoConversations(storage);
    await storage.saveMessages([row(A, 'in A')], KEY);
    const sealed = await encryptData(toMessagePayload(row(B, 'from the backup')), KEY);

    await storage.importEncryptedRow({
      id: 'shared-id',
      conversationId: B,
      timestamp: 1_000,
      ...sealed,
    });

    expect(await storage.getMessage(A, 'shared-id', KEY)).toMatchObject({ content: 'in A' });
    expect(await storage.getMessage(B, 'shared-id', KEY)).toMatchObject({
      content: 'from the backup',
    });
    expect(await storage.getAllEncryptedRows()).toHaveLength(2);
  });

  it('a device-key change re-seals both rows, each with its own payload', async () => {
    const { storage } = await open();
    await twoConversations(storage);
    await storage.saveMessages([row(A, 'in A')], KEY);
    await storage.saveMessages([row(B, 'in B')], KEY);

    await resealDeviceKeyStores(storage, KEY, NEW_KEY);

    expect(await storage.getMessage(A, 'shared-id', NEW_KEY)).toMatchObject({ content: 'in A' });
    expect(await storage.getMessage(B, 'shared-id', NEW_KEY)).toMatchObject({ content: 'in B' });
  });

  it("own-row lookup by id answers only this account's row, never another conversation's", async () => {
    const { storage } = await open();
    await twoConversations(storage);
    await storage.saveMessages([row(A, 'somebody else', { senderId: 'mallory' })], KEY);
    expect(await ownStoredMessage(storage, 'shared-id', 'alice', KEY)).toBeNull();

    await storage.saveMessages([row(B, 'mine')], KEY);
    expect(await ownStoredMessage(storage, 'shared-id', 'alice', KEY)).toMatchObject({
      conversationId: B,
      content: 'mine',
    });
  });
});

describe.each(backends)('%s - moveMessages', (_name, open) => {
  it('moves a row onto another conversation, every field with it, in one step', async () => {
    const { storage, reload } = await open();
    await twoConversations(storage);
    await storage.saveMessages(
      [
        row(A, 'the body', {
          id: 'm1',
          isEdited: true,
          reactions: [{ userId: 'bob', emoji: 'x', at: 1 }],
        }),
      ],
      KEY
    );

    const move = await storage.moveMessages(A, B, ['m1', 'not-there'], KEY);

    expect(move).toEqual({ moved: ['m1'], alreadyThere: [], kept: [] });
    const again = await reload();
    expect(await again.getMessage(A, 'm1', KEY)).toBeNull();
    expect(await again.getMessage(B, 'm1', KEY)).toMatchObject({
      conversationId: B,
      content: 'the body',
      isEdited: true,
      reactions: [{ userId: 'bob', emoji: 'x', at: 1 }],
    });
    // A moved row is a new revision: a compare-and-set that read it before retries.
    expect(await again.updateMessage(B, 'm1', { isDeleted: true }, KEY)).toBeUndefined();
    expect(await again.getMessage(B, 'm1', KEY)).toMatchObject({ isDeleted: true });
  });

  it('a row the destination already holds is UNITED with the source, nothing lost, then the source removed', async () => {
    const { storage, reload } = await open();
    await twoConversations(storage);
    // The source: this device's tombstone with its proof, a reaction, the recorded 410.
    const proof = { body: 'b', proof: 'p', group: A };
    await storage.saveMessages(
      [
        row(A, '', {
          isDeleted: true,
          deleteProof: proof,
          reactions: [{ userId: 'bob', emoji: 'x', at: 2 }],
          mediaPurgedAt: 70,
        }),
      ],
      KEY
    );
    // The destination: a bare copy stored first (a bundle, a replayed copy, an echo).
    await storage.saveMessages(
      [row(B, 'the original body', { reactions: [{ userId: 'carol', emoji: 'y', at: 3 }] })],
      KEY
    );

    expect(await storage.moveMessages(A, B, ['shared-id'], KEY)).toEqual({
      moved: [],
      alreadyThere: ['shared-id'],
      kept: [],
    });

    const again = await reload();
    expect(await again.getMessage(A, 'shared-id', KEY)).toBeNull();
    const united = await again.getMessage(B, 'shared-id', KEY);
    expect(united).toMatchObject({ isDeleted: true, content: '', mediaPurgedAt: 70 });
    expect(united?.deleteProof).toEqual(proof);
    expect(united?.reactions?.map((r) => r.emoji).sort()).toEqual(['x', 'y']);
    expect(await again.moveMessages(A, B, ['shared-id'], KEY)).toEqual({
      moved: [],
      alreadyThere: [],
      kept: [],
    });
  });

  it('the other way round: a tombstone already at the destination stays, the source body does not come back', async () => {
    const { storage } = await open();
    await twoConversations(storage);
    await storage.saveMessages(
      [row(A, 'the original body', { unsentReason: 'not-a-member' as never })],
      KEY
    );
    await storage.saveMessages([row(B, '', { isDeleted: true })], KEY);

    await storage.moveMessages(A, B, ['shared-id'], KEY);

    expect(await storage.getMessage(B, 'shared-id', KEY)).toMatchObject({
      isDeleted: true,
      content: '',
      unsentReason: 'not-a-member',
    });
  });

  it('a pair one side of which does not open is left as it is', async () => {
    const { storage } = await open();
    await twoConversations(storage);
    await storage.saveMessages([row(A, 'sealed under another key')], NEW_KEY);
    await storage.saveMessages([row(B, 'the row of B')], KEY);

    expect(await storage.moveMessages(A, B, ['shared-id'], KEY)).toEqual({
      moved: [],
      alreadyThere: [],
      kept: ['shared-id'],
    });
    expect(await storage.getMessageStanding(A, 'shared-id', KEY)).toEqual({ kind: 'unreadable' });
    expect(await storage.getMessage(B, 'shared-id', KEY)).toMatchObject({
      content: 'the row of B',
    });
  });
});

describe('IndexedDbStorage - a re-key the store refuses', () => {
  it('rejects the move whole: no row reported, every row where it was', async () => {
    const { storage } = await idbRig();
    await twoConversations(storage);
    await storage.saveMessages(
      [row(A, 'first', { id: 'm1' }), row(A, 'second', { id: 'm2' })],
      KEY
    );
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ) {
      if ((value as { id?: string }).id === 'm2')
        throw new DOMException('full', 'QuotaExceededError');
      return put.call(this, value, key);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(storage.moveMessages(A, B, ['m1', 'm2'], KEY)).rejects.toBeDefined();
    vi.mocked(IDBObjectStore.prototype.put).mockRestore();

    expect(await storage.getMessage(A, 'm1', KEY)).toMatchObject({ content: 'first' });
    expect(await storage.getMessage(A, 'm2', KEY)).toMatchObject({ content: 'second' });
    expect(await storage.getMessage(B, 'm1', KEY)).toBeNull();
  });
});

describe('SQLite v22 -> v23: the messages table re-keyed by its conversation', () => {
  /** The `messages` table every build up to v22 created: keyed by the id alone. */
  const V22_MESSAGES = `
    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      timestamp       INTEGER,
      iv              TEXT,
      cipher_text     TEXT,
      order_at        INTEGER,
      order_pending   INTEGER,
      rev             INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )`;

  /** A v22 file: `rows` messages over two conversations, sealed under KEY, stamped 22. */
  async function v22File(rows: number) {
    const { engine, db } = sqliteEngine();
    const first = await sqliteOver(db);
    await twoConversations(first);
    engine.exec('DROP TABLE messages');
    engine.exec(V22_MESSAGES);
    engine.exec('CREATE INDEX idx_messages_conv ON messages(conversation_id)');
    const insert = engine.prepare(
      'INSERT INTO messages (id, conversation_id, timestamp, iv, cipher_text, order_at, order_pending, rev) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)'
    );
    for (let i = 0; i < rows; i++) {
      const conversationId = i % 2 === 0 ? A : B;
      const sealed = await encryptData(
        toMessagePayload(row(conversationId, `body ${i}`, { id: `m${i}` })),
        KEY
      );
      insert.run(
        `m${i}`,
        conversationId,
        1_000 + i,
        btoa(String.fromCharCode(...sealed.iv)),
        btoa(String.fromCharCode(...sealed.cipherText)),
        1_000 + i,
        i
      );
    }
    engine.exec('PRAGMA user_version = 22');
    return { engine, db };
  }

  const primaryKey = (engine: any) =>
    (engine.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);

  async function expectEveryRow(engine: any, db: unknown, rows: number) {
    const upgraded = await sqliteOver(db);
    expect(SCHEMA_VERSION).toBe(23);
    expect(engine.prepare('PRAGMA user_version').get()).toEqual({ user_version: 23 });
    expect(primaryKey(engine)).toEqual(['conversation_id', 'id']);
    expect(
      engine
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(MESSAGES_REKEY_STAGING)
    ).toEqual([]);
    expect(engine.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: rows });
    for (let i = 0; i < rows; i++) {
      const conversationId = i % 2 === 0 ? A : B;
      expect(await upgraded.getMessage(conversationId, `m${i}`, KEY)).toMatchObject({
        content: `body ${i}`,
      });
    }
    // Revisions are carried, and the new key takes a second row under a held id.
    expect(engine.prepare("SELECT rev FROM messages WHERE id = 'm3'").get()).toEqual({ rev: 3 });
    expect(
      (await upgraded.saveMessagesIfAbsent([row(B, 'second row', { id: 'm0' })], KEY)).size
    ).toBe(1);
    // The indexes are made again on the new table.
    const indexes = (
      engine
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_messages_conv',
        'idx_messages_id',
        'idx_messages_conv_order',
        'idx_messages_order_pending',
        'idx_messages_order_missing',
      ])
    );
    return upgraded;
  }

  it('keeps every row', async () => {
    const { engine, db } = await v22File(40);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expectEveryRow(engine, db, 40);
  });

  it('resumes a rebuild killed after the staging table was made and half the rows copied', async () => {
    const { engine, db } = await v22File(40);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const steps = messageRekeySteps({
      keyed: false,
      staging: false,
      columns: [
        'id',
        'conversation_id',
        'timestamp',
        'iv',
        'cipher_text',
        'order_at',
        'order_pending',
        'rev',
      ],
    });
    engine.exec(steps.copy[0]);
    engine.exec(
      `INSERT INTO ${MESSAGES_REKEY_STAGING} SELECT * FROM messages WHERE id IN ('m0', 'm1', 'm2')`
    );
    await expectEveryRow(engine, db, 40);
  });

  it('resumes a rebuild killed after the copy, before the old table was dropped', async () => {
    const { engine, db } = await v22File(40);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const steps = messageRekeySteps({
      keyed: false,
      staging: false,
      columns: [
        'id',
        'conversation_id',
        'timestamp',
        'iv',
        'cipher_text',
        'order_at',
        'order_pending',
        'rev',
      ],
    });
    for (const statement of steps.copy) engine.exec(statement);
    await expectEveryRow(engine, db, 40);
  });

  it('resumes a rebuild killed between the drop and the rename', async () => {
    const { engine, db } = await v22File(40);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const steps = messageRekeySteps({
      keyed: false,
      staging: false,
      columns: [
        'id',
        'conversation_id',
        'timestamp',
        'iv',
        'cipher_text',
        'order_at',
        'order_pending',
        'rev',
      ],
    });
    for (const statement of steps.copy) engine.exec(statement);
    engine.exec(steps.drop[0]);
    // The next open's own `CREATE TABLE IF NOT EXISTS messages` makes an empty keyed table first.
    await expectEveryRow(engine, db, 40);
  });

  it('owes nothing on a file already keyed, and nothing twice', () => {
    expect(messageRekeySteps({ keyed: true, staging: false, columns: [] })).toEqual({
      copy: [],
      drop: [],
    });
    const resumed = messageRekeySteps({
      keyed: true,
      staging: true,
      columns: ['id', 'conversation_id'],
    });
    expect(resumed.copy).toEqual([
      `INSERT OR IGNORE INTO ${MESSAGES_REKEY_STAGING} (id, conversation_id) SELECT id, conversation_id FROM messages`,
    ]);
    expect(resumed.drop[0]).toBe('DROP TABLE messages');
  });
});

describe('IndexedDB v14 -> v15: the messages store re-keyed by its conversation', () => {
  /** A v14 database: `rows` messages over two conversations, keyed by the id alone. */
  async function v14Database(rows: number): Promise<string> {
    const userId = `v14-${Date.now()}-${n++}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`CanariDB_${userId}`, 14);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('conversations', { keyPath: 'id' });
        const store = req.result.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('byConversation', 'conversationId', { unique: false });
        store.createIndex('byConversationTime', ['conversationId', 'timestamp'], { unique: false });
        store.createIndex('byConversationOrder', ['conversationId', 'orderAt', 'id'], {
          unique: false,
        });
        store.createIndex('byConversationPending', ['conversationId', 'orderPending', 'id'], {
          unique: false,
        });
        for (const s of [
          'outbox',
          'graine',
          'pendingGroupExits',
          'distributionGroups',
          'feedPages',
        ]) {
          const keyPath =
            s === 'graine'
              ? 'sessionId'
              : s === 'feedPages'
                ? 'key'
                : s.startsWith('pending') || s.startsWith('distribution')
                  ? 'groupId'
                  : 'id';
          const created = req.result.createObjectStore(s, { keyPath });
          if (s === 'outbox') {
            created.createIndex('byConversation', 'conversationId', { unique: false });
            created.createIndex('bySentAt', 'sentAt', { unique: false });
          }
          if (s === 'graine') {
            created.createIndex('byChannel', 'channelId', { unique: false });
            created.createIndex('byWorkspace', 'workspaceId', { unique: false });
          }
        }
        const pending = req.result.createObjectStore('pendingMutations', {
          keyPath: ['conversationId', 'messageTag', 'senderTag', 'kind', 'slotTag'],
        });
        pending.createIndex('bySenderTierAt', ['conversationId', 'senderTag', 'tier', 'at'], {
          unique: false,
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const records = await Promise.all(
      Array.from({ length: rows }, async (_, i) => {
        const conversationId = i % 2 === 0 ? A : B;
        return {
          id: `m${i}`,
          conversationId,
          timestamp: 1_000 + i,
          orderAt: 1_000 + i,
          rev: i,
          ...(await encryptData(
            toMessagePayload(row(conversationId, `body ${i}`, { id: `m${i}` })),
            KEY
          )),
        };
      })
    );
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['messages', 'conversations'], 'readwrite');
      for (const r of records) tx.objectStore('messages').put(r);
      tx.objectStore('conversations').put({
        id: A,
        name: 'a',
        lifecycle: 'active',
        updatedAt: 1,
        localReadSeed: 0,
      });
      tx.objectStore('conversations').put({
        id: B,
        name: 'b',
        lifecycle: 'active',
        updatedAt: 1,
        localReadSeed: 0,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return userId;
  }

  async function expectEveryRow(userId: string, rows: number) {
    const storage = new IndexedDbStorage(userId);
    await storage.init();
    for (let i = 0; i < rows; i++) {
      const conversationId = i % 2 === 0 ? A : B;
      expect(await storage.getMessage(conversationId, `m${i}`, KEY)).toMatchObject({
        content: `body ${i}`,
      });
    }
    expect(await storage.getAllEncryptedRows()).toHaveLength(rows);
    expect((await storage.getMessagesPage(A, KEY, 100)).length).toBe(Math.ceil(rows / 2));
    expect(await storage.saveMessagesIfAbsent([row(B, 'second row', { id: 'm0' })], KEY)).toEqual(
      new Set(['m0'])
    );
    expect(await storage.findMessageConversations('m0')).toEqual([A, B]);
    const db = (storage as unknown as { ensureDb(): IDBDatabase }).ensureDb();
    expect(db.version).toBe(15);
    expect(db.transaction('messages', 'readonly').objectStore('messages').keyPath).toEqual([
      'conversationId',
      'id',
    ]);
    expect([...db.objectStoreNames]).not.toContain('messagesRekey');
    await storage.close();
  }

  it('keeps every row', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const userId = await v14Database(40);
    await expectEveryRow(userId, 40);
  });

  it('an upgrade interrupted mid-copy leaves the v14 store whole, and the next open migrates it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const userId = await v14Database(40);
    // The kill: the 10th row's copy throws inside the upgrade, which aborts its transaction.
    const put = IDBObjectStore.prototype.put;
    let copied = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (this.name === 'messagesRekey' && ++copied === 10) throw new Error('killed mid-copy');
      return put.apply(this, args);
    });
    const interrupted = new IndexedDbStorage(userId);
    await expect(interrupted.init()).rejects.toBeDefined();
    spy.mockRestore();

    // Nothing of the half-done step committed: still v14, keyed by id, every row there.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`CanariDB_${userId}`);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(raw.version).toBe(14);
    expect(raw.transaction('messages', 'readonly').objectStore('messages').keyPath).toBe('id');
    raw.close();

    await expectEveryRow(userId, 40);
  });
});
