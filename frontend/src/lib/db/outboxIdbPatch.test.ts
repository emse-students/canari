/**
 * A scheduling patch on IndexedDB runs in ONE readwrite transaction and writes only a row that still
 * exists: with the read and the write in two transactions it resurrected a row `cancelPending` had
 * deleted in between, and the flusher then sent a message the user had deleted.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import type { OutboxEntry } from './types';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
let n = 0;

const entry = (id: string, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id,
  conversationId: 'g',
  sentAt: 100,
  kind: 'text',
  text: 'hello',
  status: 'pending',
  attempts: 0,
  createdAt: 100,
  ...over,
});

async function open() {
  const storage = new IndexedDbStorage(`idb-patch-${Date.now()}-${n++}`);
  await storage.init();
  return storage;
}

describe('IndexedDbStorage.updateOutboxEntry with a scheduling patch', () => {
  it('updates the clear columns and leaves the payload readable', async () => {
    const storage = await open();
    await storage.saveOutboxEntry(entry('a'), KEY);
    await storage.updateOutboxEntry('a', { attempts: 3, nextAttemptAt: 9 }, KEY);
    const [row] = await storage.getOutboxQueue(KEY);
    expect(row).toMatchObject({ id: 'a', attempts: 3, nextAttemptAt: 9, text: 'hello' });
    storage.close();
  });

  it('does not resurrect a row deleted before the write', async () => {
    const storage = await open();
    await storage.saveOutboxEntry(entry('b'), KEY);
    await Promise.all([
      storage.deleteOutboxEntry('b'),
      storage.updateOutboxEntry('b', { attempts: 1 }, KEY),
    ]);
    await storage.updateOutboxEntry('b', { attempts: 2 }, KEY);
    expect(await storage.getOutboxQueue(KEY)).toEqual([]);
    storage.close();
  });

  it('runs get and put inside a single readwrite transaction', async () => {
    const storage = await open();
    await storage.saveOutboxEntry(entry('c'), KEY);
    const modes: string[] = [];
    const real = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      stores: any,
      mode?: IDBTransactionMode
    ) {
      modes.push(String(mode));
      return real.call(this, stores, mode);
    });
    await storage.updateOutboxEntry('c', { attempts: 1 }, KEY);
    spy.mockRestore();
    expect(modes).toEqual(['readwrite']);
    storage.close();
  });
});
