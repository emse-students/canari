/**
 * `getMessageConversationIds` finds the salons whose last page this device stores (F4 of
 * community-open-budget) - rows NO conversation row names, so `getConversations` cannot. The sweep of
 * the salons a listing no longer names stands on it (`sweepStoredSalonPages`).
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import type { StoredMessage } from './types';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
let n = 0;

const row = (id: string, conversationId: string): StoredMessage => ({
  id,
  conversationId,
  senderId: 'peer',
  content: 'x',
  timestamp: 1_700_000_000_000,
});

describe('IndexedDbStorage.getMessageConversationIds', () => {
  it('names each conversation with the prefix once, and none without it', async () => {
    const storage = new IndexedDbStorage(`conv-ids-${Date.now()}-${n++}`);
    await storage.init();
    await storage.saveMessages(
      [
        row('m1', 'channel_a'),
        row('m2', 'channel_a'),
        row('m3', 'channel_b'),
        row('m4', 'group-1'),
        row('m5', 'channelx'),
        row('m6', 'channel%x'),
      ],
      KEY
    );

    expect((await storage.getMessageConversationIds('channel_')).sort()).toEqual([
      'channel_a',
      'channel_b',
    ]);
    await storage.close();
  });
});

describe('SqliteStorage.getMessageConversationIds', () => {
  /** A real SQLite (`node:sqlite`) holding the table and index `SqliteStorage.init` creates. */
  async function sqliteHolding(ids: Array<[string, string]>) {
    const { DatabaseSync } = await import('node:sqlite');
    const engine = new DatabaseSync(':memory:');
    engine.exec(
      'CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, timestamp INTEGER, iv TEXT, cipher_text TEXT)'
    );
    engine.exec('CREATE INDEX idx_messages_conv ON messages(conversation_id)');
    const insert = engine.prepare('INSERT INTO messages (id, conversation_id) VALUES (?, ?)');
    for (const [id, conversationId] of ids) insert.run(id, conversationId);
    const sqls: string[] = [];
    // The plugin binds `$1`; `?1` is the same positional parameter for `node:sqlite`.
    const select = async (sql: string, params: unknown[]) => {
      sqls.push(sql);
      return engine.prepare(sql.replaceAll('$1', '?1')).all(...(params as string[]));
    };
    const storage = new SqliteStorage('u');
    (storage as unknown as { db: unknown }).db = { execute: vi.fn(), select };
    return { storage, engine, sqls };
  }

  it('names each conversation with the prefix once, and neither a near miss nor a pattern match', async () => {
    const { storage } = await sqliteHolding([
      ['m1', 'channel_a'],
      ['m2', 'channel_a'],
      ['m3', 'channel_b'],
      ['m4', 'group-1'],
      ['m5', 'channelx'],
      ['m6', 'channel%x'],
      ['m7', 'channel'],
    ]);

    expect((await storage.getMessageConversationIds('channel_')).sort()).toEqual([
      'channel_a',
      'channel_b',
    ]);
  });

  it('searches the conversation index for the range instead of scanning it', async () => {
    const { storage, engine, sqls } = await sqliteHolding([['m1', 'channel_a']]);
    await storage.getMessageConversationIds('channel_');

    const plan = engine
      .prepare(`EXPLAIN QUERY PLAN ${sqls[0].replaceAll('$1', '?1')}`)
      .all('channel_') as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toMatch(
      /SEARCH messages USING COVERING INDEX idx_messages_conv/
    );
    expect(sqls[0]).not.toContain('LIKE');
  });
});
