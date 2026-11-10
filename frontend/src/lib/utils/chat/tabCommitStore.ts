/**
 * THE DURABLE HALF OF A FOLLOWER TAB'S HANDED-OVER COMMITS (`tabCommitDelegation.ts`).
 *
 * ONE DATABASE PER ACCOUNT, `CanariDBTabCommit_<userId>`, like the publish queue's: the `CanariDB`
 * prefix is what the device wipe enumerates, and {@link tabCommitDbName} is listed in
 * `accountIndexedDbNames`, so a deleted or revoked account's requests die with it. A sign-out
 * abandons this tab's own requests and deletes their records (`abandonDelegatedCommits`); a record
 * another tab left is deleted by the leader's next drain, never run (its requester is gone).
 *
 * WHY INDEXEDDB AND NOT `localStorage` (review of #3160). A `localStorage` write is not ordered with
 * a `BroadcastChannel` message or a Web Lock across renderer processes: the signal could reach the
 * leader before the record was visible to it, and a drain's read-then-write could overwrite a `done`
 * another document had just written. Here every write is awaited to its COMMIT before the signal is
 * posted, and every state change is a read-check-write inside ONE `readwrite` transaction
 * ({@link TabCommitStore.update}), which IndexedDB serialises across tabs.
 *
 * THE RECORD IS NOT SEALED BY THE DEVICE KEY, deliberately and like the publish queue: it holds what
 * a commit gesture carries - a group's name, user ids - which the conversation rows of
 * `CanariDB_<userId>` hold in the clear already, and it lives only until the request is answered and
 * read. Sealing it would make a PIN change strand every record in flight. A SECRET a request carries
 * (a send's plaintext, an exporter read and its answer: `tabSendDelegation.ts`) is the exception: it
 * is its own `payload` field, sealed under the device key, and the delegation drops it from the
 * record the moment a leader claims it - an answered record never holds the REQUEST's payload. An
 * `export-secret` ANSWER is the one secret a record does hold: its `outcome` carries the exported
 * secret, sealed the same way, from the leader's settle until the asking document reads and deletes
 * the record (or, that document gone, until the leader's next drain removes it). A PIN change
 * between seal and open only makes that one request answer `unreadable`.
 */
import { idbCommitted, idbRequest } from '$lib/db/outboxBlob';

const DB_PREFIX = 'CanariDBTabCommit_';
const DB_VERSION = 1;
const REQUESTS = 'requests';

/** Thrown by a store of an account wiped in this document: it never re-creates the database. */
export class TabCommitAccountWipedError extends Error {
  constructor(readonly userId: string) {
    super(
      `[TAB-COMMIT] the account ${userId.slice(0, 8)}... was wiped here - its store stays closed`
    );
    this.name = 'TabCommitAccountWipedError';
  }
}

/**
 * The accounts whose database this document saw wiped, and every store it opened. An
 * `indexedDB.open` CREATES a database it does not find, so a store of a wiped account would bring
 * `CanariDBTabCommit_<id>` back the next time a drain read it; it refuses instead, until that
 * account is signed in here again ({@link readmitTabCommitAccount}).
 */
const wipedAccounts = new Set<string>();
const openedStores = new Set<{ readonly userId: string; close(): void }>();

/**
 * The account's data is being wiped (`accountLocalWipe.ts`, before its databases are deleted):
 * every store of it closes, and none opens again in this document.
 */
export function forgetTabCommitAccount(userId: string): void {
  wipedAccounts.add(userId);
  for (const store of openedStores) {
    if (store.userId === userId) store.close();
  }
}

/** Test seam: how many stores hold (or are opening) a connection in this document. */
export function openTabCommitStoreCountForTests(): number {
  return openedStores.size;
}

/** Whether the account's database was wiped in this document and not signed in again since. */
export function isTabCommitAccountWiped(userId: string): boolean {
  return wipedAccounts.has(userId);
}

/** The account is signed in here again (a revoked device's account still exists): its store may open. */
export function readmitTabCommitAccount(userId: string): void {
  wipedAccounts.delete(userId);
}

/** The database for `userId` - also what the account wipe deletes (`accountIndexedDbNames`). */
export function tabCommitDbName(userId: string): string {
  return DB_PREFIX + userId;
}

/** The store {@link import('./tabCommitDelegation').DelegationEnv} reads and writes, injected. */
export interface TabCommitStore<R extends { id: string }> {
  get(id: string): Promise<R | null>;
  list(): Promise<R[]>;
  put(record: R): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Reads the record and writes what `change` makes of it, in ONE transaction: a record, `'delete'`,
   * or `null` to leave it as it is. Resolves with the record as it stands after the commit.
   */
  update(id: string, change: (current: R | null) => R | 'delete' | null): Promise<R | null>;
}

/** {@link TabCommitStore} over the account's IndexedDB. */
export class IdbTabCommitStore<R extends { id: string }> implements TabCommitStore<R> {
  private db: Promise<IDBDatabase> | null = null;

  constructor(readonly userId: string) {}

  /**
   * Closes the connection, if one is open, and leaves the registry: a later call opens a new one
   * (and registers again) unless the account is wiped.
   */
  close(): void {
    openedStores.delete(this);
    const db = this.db;
    this.db = null;
    void db?.then(
      (open) => open.close(),
      () => undefined
    );
  }

  private open(): Promise<IDBDatabase> {
    if (wipedAccounts.has(this.userId)) {
      return Promise.reject(new TabCommitAccountWipedError(this.userId));
    }
    // Registered while it may hold a connection, so a wipe can close it; `close` removes it.
    openedStores.add(this);
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(tabCommitDbName(this.userId), DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(REQUESTS)) {
          db.createObjectStore(REQUESTS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // The account wipe's `deleteDatabase` asks every connection to go: this one does.
        db.onversionchange = () => {
          console.info('[TAB-COMMIT] store closed: the database is being deleted');
          db.close();
          this.db = null;
          openedStores.delete(this);
        };
        resolve(db);
      };
      req.onerror = () => {
        this.db = null;
        openedStores.delete(this);
        reject(req.error);
      };
    });
    return this.db;
  }

  async get(id: string): Promise<R | null> {
    const db = await this.open();
    const tx = db.transaction(REQUESTS, 'readonly');
    const record = (await idbRequest(tx.objectStore(REQUESTS).get(id))) as R | undefined;
    return record ?? null;
  }

  async list(): Promise<R[]> {
    const db = await this.open();
    const tx = db.transaction(REQUESTS, 'readonly');
    return (await idbRequest(tx.objectStore(REQUESTS).getAll())) as R[];
  }

  async put(record: R): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(REQUESTS, 'readwrite');
    const done = idbCommitted(tx);
    tx.objectStore(REQUESTS).put(record);
    await done;
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(REQUESTS, 'readwrite');
    const done = idbCommitted(tx);
    tx.objectStore(REQUESTS).delete(id);
    await done;
  }

  async update(id: string, change: (current: R | null) => R | 'delete' | null): Promise<R | null> {
    const db = await this.open();
    const tx = db.transaction(REQUESTS, 'readwrite');
    const done = idbCommitted(tx);
    const store = tx.objectStore(REQUESTS);
    let after: R | null = null;
    const read = store.get(id);
    read.onsuccess = () => {
      // INSIDE the transaction: nothing else can write this record between the read and the write.
      const current = (read.result as R | undefined) ?? null;
      const next = change(current);
      if (next === 'delete') {
        store.delete(id);
        after = null;
      } else if (next === null) {
        after = current;
      } else {
        store.put(next);
        after = next;
      }
    };
    await done;
    return after;
  }
}
