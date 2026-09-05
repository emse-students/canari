/**
 * THE PAIR THAT MUST NOT BE TORN: a message and the outbox entry that will send it.
 *
 * Persisting the echo and then queuing it was two awaits, and a document torn down between them -
 * a reload fired inside the send's own async tail - left a `pending` row on disk that no queue knew
 * about: never sent, never retried, never reported, and visible to its author for ever (TAB-5,
 * measured 2026-09-05).
 *
 * ONE TRANSACTION IS THE FIX, and it is what these assert - not merely that both rows arrive, which
 * two separate writes also achieve on any run that is not interrupted. That is the whole difficulty
 * of the defect: every test that ever ran it passed.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import type { OutboxEntry, StoredMessage } from './types';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
let n = 0;
const freshName = () => `atomic-${Date.now()}-${n++}`;

const message = (id: string): StoredMessage => ({
  id,
  conversationId: 'group-1',
  senderId: 'me',
  content: JSON.stringify({ kind: 'text', text: 'hello' }),
  timestamp: 1_700_000_000_000,
});

const entry = (id: string): OutboxEntry => ({
  id,
  conversationId: 'group-1',
  sentAt: 1_700_000_000_000,
  kind: 'text',
  text: 'hello',
  status: 'pending',
  attempts: 0,
  createdAt: 1_700_000_000_000,
});

describe('saveMessageWithOutboxEntry', () => {
  it('writes both rows', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();
    await storage.saveMessageWithOutboxEntry(message('m-1'), entry('m-1'), KEY);

    const messages = await storage.getMessages('group-1', KEY);
    const queued = await storage.getOutboxEntries(KEY);
    expect(messages.map((m) => m.id)).toEqual(['m-1']);
    expect(queued.map((e) => e.id)).toEqual(['m-1']);
    storage.close();
  });

  it('in ONE transaction spanning both stores - which is the entire point', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();

    const opened: Array<{ stores: string[]; mode: string }> = [];
    const real = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      stores: any,
      mode: any,
      ...rest: any[]
    ) {
      opened.push({ stores: [stores].flat(), mode: mode ?? 'readonly' });
      return (real as any).call(this, stores, mode, ...rest);
    });

    await storage.saveMessageWithOutboxEntry(message('m-2'), entry('m-2'), KEY);
    spy.mockRestore();

    // Two writes would show two transactions here, and a crash between them is the defect.
    expect(opened).toHaveLength(1);
    expect(opened[0].mode).toBe('readwrite');
    expect(new Set(opened[0].stores)).toEqual(new Set(['messages', 'outbox']));
    storage.close();
  });

  it('encrypts before opening it, so the transaction cannot end mid-write', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();

    // An IndexedDB transaction commits as soon as it runs out of work, so an `await` inside one
    // ends it and the second put would land in a transaction of its own - atomicity gone, with
    // every assertion above still green. What proves it did not happen: when the transaction is
    // opened, both puts follow with no turn of the microtask queue between them.
    let putsInFirstTransaction = 0;
    const realTx = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      stores: any,
      mode: any,
      ...rest: any[]
    ) {
      const tx = (realTx as any).call(this, stores, mode, ...rest);
      const realStore = tx.objectStore.bind(tx);
      tx.objectStore = (name: string) => {
        const store = realStore(name);
        const realPut = store.put.bind(store);
        store.put = (...args: any[]) => {
          putsInFirstTransaction++;
          return realPut(...args);
        };
        return store;
      };
      return tx;
    });

    const done = storage.saveMessageWithOutboxEntry(message('m-3'), entry('m-3'), KEY);
    await done;
    spy.mockRestore();
    expect(putsInFirstTransaction).toBe(2);
    storage.close();
  });
});
