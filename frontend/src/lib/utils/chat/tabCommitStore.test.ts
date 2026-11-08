/**
 * The handed-over commits' store over a real IndexedDB implementation (fake-indexeddb).
 *
 * Pinned: a read-check-write is one transaction; a wiped account's store closes, lets the wipe's
 * `deleteDatabase` through, and never re-creates the database until the account signs in again.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  forgetTabCommitAccount,
  IdbTabCommitStore,
  openTabCommitStoreCountForTests,
  readmitTabCommitAccount,
  TabCommitAccountWipedError,
  tabCommitDbName,
} from './tabCommitStore';

let n = 0;
const user = () => `user-${++n}`;

type Row = { id: string; state: string };

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? '');
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked by an open connection'));
  });
}

describe('IdbTabCommitStore', () => {
  it('moves a record only from the state the change expects, in one transaction', async () => {
    const store = new IdbTabCommitStore<Row>(user());
    await store.put({ id: 'r', state: 'pending' });

    const claimed = await store.update('r', (r) =>
      r?.state === 'pending' ? { ...r, state: 'running' } : null
    );
    const again = await store.update('r', (r) =>
      r?.state === 'pending' ? { ...r, state: 'running' } : null
    );

    expect(claimed).toEqual({ id: 'r', state: 'running' });
    // A second claim leaves the record as it stands.
    expect(again).toEqual({ id: 'r', state: 'running' });
    expect(await store.update('r', () => 'delete')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("a wiped account's store closes, lets the delete through, and never re-creates the database", async () => {
    const id = user();
    const store = new IdbTabCommitStore<Row>(id);
    const before = openTabCommitStoreCountForTests();
    await store.put({ id: 'r', state: 'pending' });
    expect(openTabCommitStoreCountForTests()).toBe(before + 1);

    forgetTabCommitAccount(id);
    await deleteDatabase(tabCommitDbName(id));

    await expect(store.list()).rejects.toBeInstanceOf(TabCommitAccountWipedError);
    await expect(new IdbTabCommitStore<Row>(id).get('r')).rejects.toBeInstanceOf(
      TabCommitAccountWipedError
    );
    expect(await databaseNames()).not.toContain(tabCommitDbName(id));

    // Forgotten, the store left the registry: a wipe holds no reference to it.
    expect(openTabCommitStoreCountForTests()).toBe(before);

    // Signed in here again (a revoked device's account still exists): the store opens, empty.
    readmitTabCommitAccount(id);
    expect(await store.list()).toEqual([]);
  });
});
