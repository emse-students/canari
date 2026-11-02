/**
 * A PAYLOAD PATCH NEVER RESURRECTS A ROW (RC-13 review). `updateOutboxEntry` decrypts the row, merges,
 * and writes it back; a withdrawal or a send that deletes the row WHILE it decrypts must leave it
 * deleted - on SQLite the write is an `UPDATE ... WHERE id` (an `INSERT OR REPLACE` put it back), on
 * IndexedDB a get-then-put in one transaction. The deletion is placed inside the decrypt, so the
 * interleaving is the one asserted, never a timing.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { SqliteStorage } from './sqlite';
import type { OutboxEntry } from './types';
import { attachFakeOutboxSql } from '../../test/outboxSqlFake';
import { MediaKind } from '$lib/proto/codec';

const during = vi.hoisted(() => ({ decrypt: null as null | (() => Promise<void>) }));
vi.mock('../encryption', async (importOriginal) => {
  const real = await importOriginal<typeof import('../encryption')>();
  return {
    ...real,
    decryptData: async (...args: Parameters<typeof real.decryptData>) => {
      const hook = during.decrypt;
      during.decrypt = null;
      if (hook) await hook();
      return real.decryptData(...args);
    },
  };
});

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
let n = 0;

const entry = (id: string): OutboxEntry => ({
  id,
  conversationId: 'g',
  sentAt: 100,
  kind: 'media',
  status: 'pending',
  attempts: 0,
  createdAt: 100,
  media: {
    kind: MediaKind.MEDIA_KIND_VIDEO,
    mimeType: 'video/mp4',
    size: 3,
    fileBytes: new Uint8Array([1, 2, 3]),
  },
});

async function engines() {
  const idb = new IndexedDbStorage(`payload-patch-${n++}`);
  await idb.init();
  const sqlite = new SqliteStorage(`payload-patch-${n++}`);
  attachFakeOutboxSql(sqlite);
  return { idb, sqlite };
}

describe('updateOutboxEntry with a payload patch', () => {
  it.each(['idb', 'sqlite'] as const)(
    '%s: a row deleted while the merge decrypts stays deleted, and the bytes the patch carried go',
    async (engine) => {
      const storage = (await engines())[engine];
      await storage.saveOutboxEntry(entry('a'), KEY);
      during.decrypt = () => storage.deleteOutboxEntry('a');
      await storage.updateOutboxEntry(
        'a',
        { media: { ...entry('a').media!, fileBytes: new Uint8Array([9, 9]) } },
        KEY
      );
      expect(await storage.getOutboxQueue(KEY)).toEqual([]);
      expect(await storage.getOutboxEntry('a', KEY)).toBeNull();
      expect(
        await (storage as unknown as { blobs: { list(): Promise<unknown[]> } }).blobs.list()
      ).toEqual([]);
    }
  );

  it.each(['idb', 'sqlite'] as const)('%s: a row still there is merged', async (engine) => {
    const storage = (await engines())[engine];
    await storage.saveOutboxEntry(entry('b'), KEY);
    await storage.updateOutboxEntry('b', { media: { ...entry('b').media!, caption: 'hi' } }, KEY);
    expect((await storage.getOutboxEntry('b', KEY))?.media?.caption).toBe('hi');
  });
});
