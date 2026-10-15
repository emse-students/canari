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
  it('compares the prefix exactly, bound as a parameter, never as a LIKE pattern', async () => {
    const storage = new SqliteStorage('u');
    const select = vi.fn().mockResolvedValue([{ conversation_id: 'channel_a' }]);
    (storage as unknown as { db: unknown }).db = { execute: vi.fn(), select };

    expect(await storage.getMessageConversationIds('channel_')).toEqual(['channel_a']);
    const [sql, params] = select.mock.calls[0];
    expect(sql).toContain('SELECT DISTINCT conversation_id FROM messages');
    expect(sql).not.toContain('LIKE');
    expect(params).toEqual(['channel_']);
  });
});
