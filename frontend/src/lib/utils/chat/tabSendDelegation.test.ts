/**
 * A FOLLOWER'S SECRETS NEVER REST IN THE CLEAR (third review of #3326).
 *
 * The delegation's store is deliberately unsealed: it holds ids. A send's plaintext (a message, a
 * media key, Graine key material) and an exporter read cross it SEALED under the device key, and the
 * sealed payload is dropped from the record the moment a leader claims it - an answered record never
 * holds one. Read here from the RAW IndexedDB records (fake-indexeddb), not through the module.
 */
import 'fake-indexeddb/auto';
import type { TabCommitEvent } from '$lib/mls-client/tabMessageSync';
import { DELIVERY } from '$lib/mls-client/frameDelivery';
import { toBase64 } from '$lib/utils/hex';
import {
  createDelegationClient,
  createDelegationServer,
  type DelegationEnv,
  type DelegationLocks,
  type DelegationReadiness,
  type DelegationRecord,
} from './tabCommitDelegation';
import { IdbTabCommitStore, tabCommitDbName } from './tabCommitStore';
import { delegatedSendExecutors, sealTabPayload, sendThroughLeaderTab } from './tabSendDelegation';

const PLAINTEXT = 'the-media-key-and-a-message-nobody-may-read-at-rest';
const plaintextBytes = new TextEncoder().encode(PLAINTEXT);
const deviceKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));

let accounts = 0;

/** Exclusive locks in one realm; a held lock asked `ifAvailable` answers null. */
function locks(): DelegationLocks {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  return {
    request<T>(
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: unknown) => Promise<T> | T
    ): Promise<T> {
      const run = (): Promise<T> => {
        held.add(name);
        return Promise.resolve()
          .then(() => callback({ name }))
          .finally(() => {
            held.delete(name);
            queues.get(name)?.shift()?.();
          });
      };
      if (!held.has(name)) return run();
      if (options.ifAvailable) return Promise.resolve(callback(null));
      return new Promise<T>((resolve, reject) => {
        const queue = queues.get(name) ?? [];
        queue.push(() => run().then(resolve, reject));
        queues.set(name, queue);
      });
    },
  };
}

/** Every raw record of `account`'s store, as IndexedDB holds it. */
async function rawRecords(account: string): Promise<unknown[]> {
  // Never CREATE the database here: an open of a missing one would make it without its store.
  const names = (await indexedDB.databases()).map((d) => d.name);
  if (!names.includes(tabCommitDbName(account))) return [];
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(tabCommitDbName(account));
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('requests', 'readonly').objectStore('requests').getAll();
      read.onsuccess = () => {
        db.close();
        resolve(read.result);
      };
      read.onerror = () => reject(read.error);
    };
  });
}

function world() {
  const account = `acct-${++accounts}`;
  const shared = locks();
  const handlers = new Set<(e: TabCommitEvent) => void>();
  const stores = new Map<string, IdbTabCommitStore<DelegationRecord>>();
  let n = 0;
  const env = (readiness: DelegationReadiness, leader: boolean): DelegationEnv => ({
    storeFor: (a) => {
      let store = stores.get(a);
      if (!store) {
        store = new IdbTabCommitStore<DelegationRecord>(a);
        stores.set(a, store);
      }
      return store;
    },
    locks: shared,
    post: (e) => {
      for (const h of handlers) setTimeout(() => h(e), 0);
    },
    subscribe: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    account: () => account,
    serves: () => leader,
    answers: () => leader,
    wiped: () => false,
    readiness: () => readiness,
    newId: () => `req-${++n}`,
    log: () => undefined,
  });
  return { account, locks: shared, env };
}

/** Whether a record, serialised whole, shows the plaintext in any spelling. */
function exposes(records: unknown[]): boolean {
  const text = JSON.stringify(records);
  return text.includes(PLAINTEXT) || text.includes(toBase64(plaintextBytes));
}

describe('a send handed to the leader tab, at rest', () => {
  it('waits in the store SEALED: the raw record holds no plaintext, in any spelling', async () => {
    const w = world();
    const follower = createDelegationClient(w.env('ready', false));

    // No leader drains yet: the request rests in the store.
    void sendThroughLeaderTab('g1', plaintextBytes, DELIVERY.visible, deviceKey, {
      leadership: () => 'follower',
      delegate: follower.delegate,
    });
    let rows: unknown[] = [];
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
      rows = await rawRecords(w.account);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'pending', op: { kind: 'send', groupId: 'g1' } });
    expect((rows[0] as DelegationRecord & { op: { payload?: unknown } }).op.payload).toBeDefined();
    expect(exposes(rows)).toBe(false);
    follower.abandon('test over');
  });

  it('the claim drops the sealed payload: while the leader runs it, the record holds none', async () => {
    const w = world();
    const follower = createDelegationClient(w.env('ready', false));
    const leader = createDelegationServer(w.env('ready', true));
    const atTheRun: unknown[][] = [];
    leader.listen();
    leader.register(
      delegatedSendExecutors(
        async () => ({
          sendMessage: async (_g: string, bytes: Uint8Array) => {
            atTheRun.push(await rawRecords(w.account));
            // The leader opened it: the plaintext reached the one place it is needed.
            expect(new TextDecoder().decode(bytes)).toBe(PLAINTEXT);
            return { sealed: new Uint8Array([1]), authorProof: new Uint8Array([2]), receivedAt: 9 };
          },
          exportSecret: async () => new Uint8Array(),
        }),
        () => deviceKey
      )
    );

    const sent = await sendThroughLeaderTab('g1', plaintextBytes, DELIVERY.visible, deviceKey, {
      leadership: () => 'follower',
      delegate: follower.delegate,
    });

    expect(sent.receivedAt).toBe(9);
    expect(atTheRun).toHaveLength(1);
    expect(atTheRun[0]).toEqual([
      expect.objectContaining({ state: 'running', op: { kind: 'send', groupId: 'g1' } }),
    ]);
  });

  it('an ANSWERED record never keeps it - a refusal of a still-pending request included', async () => {
    const w = world();
    // A leader at its PIN gate answers `leader-unavailable` without claiming.
    const leader = createDelegationServer(w.env('unavailable', true));
    const store = new IdbTabCommitStore<DelegationRecord>(w.account);
    // The asking document is alive: it holds its requester lock for the whole test.
    let releaseRequester = () => {};
    void w.locks.request(
      'canari.tab-commit.requester.r1',
      {},
      () => new Promise<void>((r) => (releaseRequester = r))
    );
    await store.put({
      id: 'r1',
      account: w.account,
      state: 'pending',
      op: {
        kind: 'send',
        groupId: 'g1',
        payload: await sealTabPayload({ message: toBase64(plaintextBytes) }, deviceKey),
      },
    });

    await leader.drain('test');
    const rows = await rawRecords(w.account);
    releaseRequester();

    expect(rows).toEqual([
      expect.objectContaining({
        state: 'done',
        op: { kind: 'send', groupId: 'g1' },
        outcome: { status: 'refused', reason: 'leader-unavailable' },
      }),
    ]);
  });
});
