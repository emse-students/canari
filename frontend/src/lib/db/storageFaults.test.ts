/**
 * WHAT THE LOCAL STORE DOES WHEN IT FAILS - by INJECTION, never on a real device.
 *
 * Two questions were open and both were about a SHAPE rather than a bound: what a phone with no
 * space left actually does, and what the web client does when the browser throws its store away.
 * The device window is five years and the web window is ninety days; both are TIME bounds, so
 * nothing caps the store by SIZE and the only honest way to learn the shape is to cause it.
 *
 * The user's decision of 2026-08-19 is that this is injected and NEVER tried on the campaign phone:
 * the appliance the campaign depends on is not the place to find out.
 *
 * Every case below is written as an ANSWER, not as a wish. Where the answer is "nothing happens and
 * that is correct", the test says so and pins it, because that is the finding.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage, StorageOpenError } from './indexeddb';

// The Tauri half of the question needs both of these faked: the runtime check, so the SQLite branch
// is taken at all, and the SQLite backend, so its open can be made to fail the way a full disk does.
// Neither mock touches the IndexedDB cases below - they construct their backend directly.
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));
vi.mock('./sqlite', () => ({
  SqliteStorage: class {
    init(): Promise<void> {
      return Promise.reject(new Error('database or disk is full'));
    }
  },
}));

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

let dbCounter = 0;
const freshName = () => `faults-test-${dbCounter++}`;

/**
 * Replaces `indexedDB.open` with one that produces the outcome asked for, and restores it after.
 *
 * The request object is the real thing right up to the point of the fault: the browser's own
 * `IDBOpenDBRequest` fires exactly one of `onsuccess`, `onerror` and `onblocked`, and which one it
 * chooses is the entire question here.
 */
function withOpenOutcome(outcome: 'error' | 'blocked', run: () => Promise<void>): Promise<void> {
  const real = indexedDB.open.bind(indexedDB);
  const fault = new DOMException('quota exceeded', 'QuotaExceededError');

  (indexedDB as any).open = () => {
    const request: Record<string, unknown> = { error: outcome === 'error' ? fault : null };
    queueMicrotask(() => {
      const handler = request[outcome === 'error' ? 'onerror' : 'onblocked'];
      if (typeof handler === 'function') (handler as () => void)();
    });
    return request;
  };

  return run().finally(() => {
    (indexedDB as any).open = real;
  });
}

describe('the store cannot be opened at all', () => {
  it('rejects with the browser reason attached, not with a sentence', async () => {
    // The rejection used to be the string 'IndexedDB open error', which threw `request.error` away.
    // A caller that wanted to tell a full quota from a private window from a corrupt database could
    // only have done it by reading English back out of a message.
    await withOpenOutcome('error', async () => {
      const storage = new IndexedDbStorage(freshName());
      const failure = await storage.init().catch((e) => e);

      expect(failure).toBeInstanceOf(StorageOpenError);
      expect(failure.blocked).toBe(false);
      expect((failure.cause as DOMException).name).toBe('QuotaExceededError');
    });
  });

  it('SETTLES when the upgrade is blocked, instead of hanging until the other tab closes', async () => {
    // `onblocked` fires when this open needs a version change and another tab still holds the old
    // version open. It is neither `onsuccess` nor `onerror`, so with no handler for it the promise
    // never settled at all: start-up simply stopped, with no bound and nothing logged. A test that
    // times out is the only way that defect is ever visible, which is why it is pinned here.
    await withOpenOutcome('blocked', async () => {
      const storage = new IndexedDbStorage(freshName());
      const failure = await storage.init().catch((e) => e);

      expect(failure).toBeInstanceOf(StorageOpenError);
      expect(failure.blocked).toBe(true);
    });
  });
});

describe('a write that fails on a full disk', () => {
  it('reaches the caller as a rejection - nothing is swallowed on the way', async () => {
    const storage = new IndexedDbStorage(freshName());
    await storage.init();

    // What a full quota actually does to a write: the request errors, and the transaction errors
    // with it. Injected on the prototype so the real transaction plumbing is exercised.
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    };

    try {
      const failure = await storage
        .saveMessages(
          [
            {
              id: 'm1',
              conversationId: 'c1',
              senderId: 'u1',
              content: 'hello',
              timestamp: Date.now(),
            },
          ],
          KEY
        )
        .catch((e) => e);

      // The finding: a failed write is NOT silent. The caller is told, which is what lets the send
      // path decide - a message that was never persisted must not be reported as sent.
      expect(failure).toBeTruthy();
      expect(failure).not.toBeUndefined();
    } finally {
      IDBObjectStore.prototype.put = realPut;
    }
  });
});

describe('the store was evicted while the tab was closed', () => {
  it('opens clean and reads empty - eviction is INDISTINGUISHABLE from a first run, by construction', async () => {
    // THIS IS THE ANSWER TO THE SECOND OPEN QUESTION, and it is a shape rather than a defect.
    //
    // Quota eviction drops the whole origin bucket. The next open therefore finds no database, runs
    // the upgrade path from version 0 and hands back an empty store - which is byte for byte what a
    // browser that has never seen Canari does. Nothing local survives to tell the two apart,
    // because anything that could have (localStorage, the caches) is inside the same bucket the
    // browser just emptied.
    //
    // The consequence is bounded, and that is why no machinery is proposed here: an empty store is
    // a NEW DEVICE, and the new-device path already exists and already re-joins. What is lost is
    // local history, which the server can replay, and the MLS state, which is re-established by
    // enrolling again. A client that pretended otherwise would be claiming knowledge it does not
    // have.
    const name = freshName();

    const first = new IndexedDbStorage(name);
    await first.init();
    await first.saveMessages(
      [{ id: 'm1', conversationId: 'c1', senderId: 'u1', content: 'hi', timestamp: 1 }],
      KEY
    );
    expect(await first.getMessages('c1', KEY)).toHaveLength(1);
    await first.close();

    await new Promise<void>((resolve, reject) => {
      // The store is scoped per user, so the database is `CanariDB_<userId>` - deleting the raw
      // name deletes nothing and quietly proves nothing.
      const request = indexedDB.deleteDatabase(`CanariDB_${name}`);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      // A delete with a connection still open does not fail - it BLOCKS, and then completes at some
      // later moment nobody controls. `close()` above is what makes this deterministic, and this
      // handler is what would say so if it ever stopped being enough.
      request.onblocked = () => reject(new Error('delete blocked - a connection is still open'));
    });

    const afterEviction = new IndexedDbStorage(name);
    await afterEviction.init();

    expect(await afterEviction.getMessages('c1', KEY)).toEqual([]);
    await afterEviction.close();
  });
});

describe('a phone with no space left, on the Tauri build', () => {
  it('refuses to open rather than answering with a DIFFERENT store', async () => {
    // THIS IS THE ANSWER TO THE FIRST OPEN QUESTION, and the answer used to be wrong.
    //
    // A failed SQLite open was caught and quietly answered with IndexedDB inside the same webview.
    // That is not a degraded version of the same device, it is a different one: on Tauri the MLS
    // state persister writes `mls.bin` to the FILESYSTEM and does not follow this choice, so the
    // group state would have stayed on disk while the conversations and messages moved into the
    // webview's store. The client would have opened, looked healthy, and carried a history that did
    // not match its own ratchet.
    //
    // And the cause a fallback was supposed to survive is exactly the one it cannot: a device with
    // no space left. The second store is on the same full disk.
    const { getStorage } = await import('../db');

    const failure = await getStorage('usr_no_space').catch((e) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('disk is full');
  });
});
