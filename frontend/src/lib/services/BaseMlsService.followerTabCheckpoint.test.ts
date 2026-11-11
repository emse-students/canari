// @vitest-environment happy-dom
// Same import-cycle break as the other BaseMlsService specs (auth store -> composables ->
// mlsService -> subclasses -> BaseMlsService).
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
// The IndexedDB path of the version guard, never the native file.
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => false }));

const commitPendingHistoryMarks = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/history', () => ({
  commitPendingHistoryMarks,
  snapshotPendingHistoryMarks: (userId: string) => ({ userId, groups: [] }),
  noteFrameConsumed: vi.fn(),
}));

// THE ROLE OF THE TAB WHOSE CODE IS RUNNING. Both tabs share this one `BaseMlsService` module, so
// the role is set before each tab acts - exactly the fact each real document reads from its own
// election.
const role = vi.hoisted(() => ({ now: 'undecided' as 'leader' | 'follower' | 'undecided' }));
vi.mock('$lib/mls-client/tabLeader', () => ({ getTabLeadership: () => role.now }));

import { BaseMlsService } from './BaseMlsService';
import { noteMlsStateLoaded, resetStateAuthorityForTests } from '$lib/mls-client/stateAuthority';
import type * as HexModule from '$lib/utils/hex';
import { MLS_STATE_VERSION_KEY as VERSION_KEY } from '$lib/utils/hex';

/**
 * A FOLLOWER TAB NEVER WRITES THE ACCOUNT'S MLS STATE - the owner's two-tab report on web `1.6.10`
 * (2026-11-11). A second tab loaded the state as a follower, closed a history window and
 * checkpointed its copy, tagged one above the version it loaded; the leader's next checkpoint
 * reached the same number and was refused as a collision, and while the follower's counter ran
 * ahead every leader write was refused as stale - the disk held the follower's copy, behind every
 * frame and commit the leader had applied.
 *
 * TWO DOCUMENTS, ONE DISK. Each tab gets its OWN instance of `utils/hex` (its own snapshot counter
 * and its own record of what it last stored - both per document in a browser), over ONE IndexedDB.
 */
function installSharedIndexedDb(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  const makeStore = () => ({
    get(key: string) {
      const req: { result: unknown; onsuccess: (() => void) | null; onerror: null } = {
        result: undefined,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        req.result = store.get(key);
        req.onsuccess?.();
      });
      return req;
    },
    put(value: unknown, key: string) {
      store.set(key, value);
      return { onsuccess: null, onerror: null };
    },
    delete() {
      return { onsuccess: null, onerror: null };
    },
  });
  const makeTx = () => {
    const tx: { objectStore: typeof makeStore; oncomplete: (() => void) | null; onerror: null } = {
      objectStore: makeStore,
      oncomplete: null,
      onerror: null,
    };
    queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
    return tx;
  };
  vi.stubGlobal('indexedDB', {
    open() {
      const req = {
        result: { transaction: makeTx, createObjectStore: () => {} },
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null,
      };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  });
  return store;
}

/** One tab: its own `hex` module instance, and a document whose checkpoint writes through it. */
async function openTab(storedVersion: number) {
  vi.resetModules();
  const hex: typeof HexModule = await import('$lib/utils/hex');
  // What `loadMlsState` does on a load: the counter starts from the stored version.
  hex.seedMlsSnapshotSeq(storedVersion);
  const doc = {
    userId: 'u',
    currentDeviceKeyB64: 'k',
    owedSendBurns: new Map(),
    unprovenSendRatchets: new Set(),
    sendRatchetsNotDurable: BaseMlsService.prototype['sendRatchetsNotDurable'],
    writeCheckpoint: vi.fn(async (_key: string, latch: HexModule.MlsStateWriteLatch) => {
      const outcome = await hex.saveMlsStateEncrypted(
        'u',
        hex.tagMlsSnapshot(new Uint8Array([storedVersion % 256]), 'checkpoint'),
        latch
      );
      if (outcome === 'stale' || outcome === 'collision' || outcome === 'ended')
        throw new hex.MlsStateWriteRefusedError(outcome);
    }),
  };
  const persist = () =>
    (
      BaseMlsService.prototype as unknown as { persistCheckpoint(): Promise<void> }
    ).persistCheckpoint.call(doc);
  return { doc, persist };
}

describe('BaseMlsService.persistCheckpoint in two tabs of one account', () => {
  let store: Map<string, unknown>;
  let infoLines: string[];

  beforeEach(() => {
    store = installSharedIndexedDb();
    resetStateAuthorityForTests();
    commitPendingHistoryMarks.mockClear();
    infoLines = [];
    vi.spyOn(console, 'info').mockImplementation((line: string) => void infoLines.push(line));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    role.now = 'undecided';
  });

  it("a follower's checkpoint writes nothing, so the leader's next write is never refused", async () => {
    const leader = await openTab(0);
    role.now = 'leader';
    await leader.persist();
    const loaded = store.get(VERSION_KEY) as number;

    // The second tab loads that state as a follower (the incident's boot: restore, history window).
    const follower = await openTab(loaded);
    role.now = 'follower';
    noteMlsStateLoaded(false);
    await expect(follower.persist()).rejects.toMatchObject({
      name: 'MlsStateWriteRefusedError',
      outcome: 'follower-tab',
    });
    // Refused BEFORE anything is captured: no export, no write, nothing declared durable.
    expect(follower.doc.writeCheckpoint).not.toHaveBeenCalled();
    expect(store.get(VERSION_KEY)).toBe(loaded);
    expect(commitPendingHistoryMarks).toHaveBeenCalledTimes(1); // the leader's, only

    // The leader moves on: its next number is the one the follower's write used to take.
    role.now = 'leader';
    noteMlsStateLoaded(true);
    await leader.persist();
    expect(store.get(VERSION_KEY)).toBe(loaded + 1);
    expect(commitPendingHistoryMarks).toHaveBeenCalledTimes(2);
  });

  it('a follower promoted in place writes nothing until its reload', async () => {
    const tab = await openTab(5);
    noteMlsStateLoaded(false);
    role.now = 'leader'; // promoted: it leads, on the copy it loaded as a follower
    await expect(tab.persist()).rejects.toMatchObject({ outcome: 'follower-tab' });
    expect(tab.doc.writeCheckpoint).not.toHaveBeenCalled();
  });

  it('says the refusal once per page, at info, never as a failure', async () => {
    const tab = await openTab(5);
    role.now = 'follower';
    await expect(tab.persist()).rejects.toBeInstanceOf(Error);
    await expect(tab.persist()).rejects.toBeInstanceOf(Error);
    const said = infoLines.filter((l) => l.includes('does not own the MLS state'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('(follower)');
  });

  it('a document that has not been elected (a native shell, a test) still writes', async () => {
    const tab = await openTab(7);
    await tab.persist();
    expect(tab.doc.writeCheckpoint).toHaveBeenCalledTimes(1);
    expect(store.get(VERSION_KEY)).toBe(8);
  });
});
