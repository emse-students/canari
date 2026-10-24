// @vitest-environment happy-dom
import {
  tagMlsSnapshot,
  propagateMlsSnapshotVersion,
  mlsSnapshotVersion,
  seedMlsSnapshotSeq,
  saveMlsStateEncrypted,
  loadMlsState,
  MLS_STATE_ENCRYPTED_KEY,
  MLS_STATE_VERSION_KEY,
} from './hex';

// Tauri runtime detection must be false so saveMlsStateEncrypted takes the IndexedDB path.
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => false }));

/**
 * Minimal in-memory IndexedDB fake covering the single-store read-modify-write the MLS
 * persistence uses: one object store, get/put by key, ordered request callbacks, tx.oncomplete.
 * Faithful enough to exercise the write-if-newer guard without pulling in fake-indexeddb.
 */
function installFakeIndexedDb(): Map<string, unknown> {
  const store = new Map<string, unknown>();

  function makeStore() {
    return {
      get(key: string) {
        const req: {
          result: unknown;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        } = { result: undefined, onsuccess: null, onerror: null };
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
    };
  }

  function makeTx() {
    const tx: {
      objectStore: () => ReturnType<typeof makeStore>;
      oncomplete: (() => void) | null;
      onerror: (() => void) | null;
    } = { objectStore: makeStore, oncomplete: null, onerror: null };
    // Complete after pending get microtasks so onsuccess handlers run first.
    queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
    return tx;
  }

  vi.stubGlobal('indexedDB', {
    open() {
      const req: {
        result: { transaction: () => ReturnType<typeof makeTx>; createObjectStore: () => void };
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: { transaction: makeTx, createObjectStore: () => {} },
        onupgradeneeded: null,
        onsuccess: null,
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

describe('MLS snapshot versioning helpers', () => {
  it('tags snapshots with a strictly increasing version', () => {
    const a = tagMlsSnapshot(new Uint8Array([1]));
    const b = tagMlsSnapshot(new Uint8Array([2]));
    const va = mlsSnapshotVersion(a)!;
    const vb = mlsSnapshotVersion(b)!;
    expect(vb).toBeGreaterThan(va);
  });

  it('propagates a version from a plain snapshot to its encrypted bytes', () => {
    const plain = tagMlsSnapshot(new Uint8Array([1]));
    const encrypted = new Uint8Array([9, 9]);
    propagateMlsSnapshotVersion(plain, encrypted);
    expect(mlsSnapshotVersion(encrypted)).toBe(mlsSnapshotVersion(plain));
  });

  it('returns undefined for untagged bytes', () => {
    expect(mlsSnapshotVersion(new Uint8Array([7]))).toBeUndefined();
  });

  it('seedMlsSnapshotSeq raises the counter so the next tag exceeds the seed', () => {
    seedMlsSnapshotSeq(1_000_000);
    const tagged = tagMlsSnapshot(new Uint8Array([0]));
    expect(mlsSnapshotVersion(tagged)!).toBeGreaterThan(1_000_000);
  });
});

describe('saveMlsStateEncrypted write-if-newer (IndexedDB)', () => {
  let store: Map<string, unknown>;

  // The module caches its IDBDatabase promise, so the fake must be installed once and the backing
  // store cleared between tests rather than reinstalled (a new store would be orphaned).
  beforeAll(() => {
    store = installFakeIndexedDb();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    store.clear();
    seedMlsSnapshotSeq(2_000_000); // isolate versions from the helper tests above
  });

  it('writes a newer tagged snapshot and records its version', async () => {
    const fresh = tagMlsSnapshot(new Uint8Array([1, 2, 3]));
    expect(await saveMlsStateEncrypted('user-1', fresh)).toBe('written');
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.get(MLS_STATE_VERSION_KEY)).toBe(mlsSnapshotVersion(fresh));
  });

  it("skips an older write behind THIS document's own newer one, as superseded and silently", async () => {
    const older = tagMlsSnapshot(new Uint8Array([1]));
    const newer = tagMlsSnapshot(new Uint8Array([2]));
    // The newer snapshot reaches disk first; the older (slower) flush must then be skipped.
    await saveMlsStateEncrypted('user-1', newer);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // ANSWERED, so a write that must land itself (a device key change) can still fail on it, while
    // a checkpoint reads it as covered: the stored blob is a later capture of this same document.
    expect(await saveMlsStateEncrypted('user-1', older)).toBe('superseded');
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([2]));
    expect(store.get(MLS_STATE_VERSION_KEY)).toBe(mlsSnapshotVersion(newer));
  });

  it("refuses an older write behind ANOTHER document's blob as stale", async () => {
    await saveMlsStateEncrypted('user-1', tagMlsSnapshot(new Uint8Array([1])));
    // Another tab, whose counter ran further, writes after us.
    store.set(MLS_STATE_ENCRYPTED_KEY, new Uint8Array([9]));
    store.set(MLS_STATE_VERSION_KEY, 3_000_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await saveMlsStateEncrypted('user-1', tagMlsSnapshot(new Uint8Array([2])))).toBe(
      'stale'
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([9]));
  });

  /**
   * THE LATCH IS DECIDED AT THE PUT, AND SET BY THE REFUSAL ITSELF. A refused rotation's checkpoint
   * (`endOnRefusal`) and a flight of the same document captured just after it - one version above
   * the other document's - are both in the database's queue. Checked only before the write started,
   * the flight is `written`: the fresh, groupless client over the other document's good state.
   */
  it.each([
    ['collision', 1],
    ['stale', 2],
  ] as const)(
    "a refusal as %s that ends the document makes its next queued write 'ended', nothing stored",
    async (refusal, ahead) => {
      // The other document reached the version this one tags next (collision) or the one after
      // (stale by one). Read off the counter rather than seeded, which only ever raises it.
      const theirs = (mlsSnapshotVersion(tagMlsSnapshot(new Uint8Array([0]))) ?? 0) + ahead;
      store.set(MLS_STATE_ENCRYPTED_KEY, new Uint8Array([9]));
      store.set(MLS_STATE_VERSION_KEY, theirs);
      let ended = false;
      const latch = {
        isEnded: () => ended,
        endOnRefusal: () => {
          ended = true;
        },
      };
      const rotation = tagMlsSnapshot(new Uint8Array([1]));
      const flight = tagMlsSnapshot(new Uint8Array([2]));
      // Unlatched, the flight would land (collision case) or collide (stale case) - never 'ended'.
      expect(mlsSnapshotVersion(flight)).toBe(theirs + 2 - ahead);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Both started before either answers: the flight passed any start check long ago.
      const outcomes = await Promise.all([
        saveMlsStateEncrypted('user-1', rotation, latch),
        saveMlsStateEncrypted('user-1', flight, { isEnded: latch.isEnded }),
      ]);
      warn.mockRestore();

      expect(outcomes).toEqual([refusal, 'ended']);
      expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([9]));
      expect(store.get(MLS_STATE_VERSION_KEY)).toBe(theirs);
    }
  );

  it('forgets its own version after an untagged write, whose bytes it cannot vouch for', async () => {
    const older = tagMlsSnapshot(new Uint8Array([1]));
    const newer = tagMlsSnapshot(new Uint8Array([2]));
    await saveMlsStateEncrypted('user-1', newer);
    await saveMlsStateEncrypted('user-1', new Uint8Array([5])); // a restore: the version stays
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await saveMlsStateEncrypted('user-1', older)).toBe('stale');
    warn.mockRestore();
  });

  /**
   * THE CASE TWO TABS PRODUCE, AND THE ONE THE GUARD USED TO CALL "STALE".
   *
   * `_snapshotSeq` is a PER-DOCUMENT counter seeded from the stored version on load, so within one
   * document it only ever goes up and equality is impossible. Equality therefore means a SECOND
   * writer - another tab - reached the same number from the same seed. Nothing is stale: the two
   * counters are simply not comparable.
   *
   * TAB-4 drives two tabs of one client and makes this fire on an ordinary run (measured 2026-09-05,
   * `v3294 <= stored v3294`), which is what turned the line into one a reader learns to skip.
   */
  it('drops a colliding write from a second writer, and does not call it stale', async () => {
    const mine = tagMlsSnapshot(new Uint8Array([1]));
    // The other tab's bytes, carrying the SAME version - what two seeds from one stored value give.
    const theirs = propagateMlsSnapshotVersion(mine, new Uint8Array([9, 9]));
    await saveMlsStateEncrypted('user-1', mine);

    const said: string[] = [];
    // On `warn` since 2026-10-21: the refusal now fails the checkpoint, so it is a real one.
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a) => void said.push(a.join(' ')));
    const outcome = await saveMlsStateEncrypted('user-1', theirs);
    spy.mockRestore();
    expect(outcome).toBe('collision');

    // The write is dropped - that is the existing behaviour and this test does not change it.
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([1]));
    expect(store.get(MLS_STATE_VERSION_KEY)).toBe(mlsSnapshotVersion(mine));
    // What it must not do is describe a collision as staleness.
    expect(said.join('\n')).toContain('collides');
    expect(said.join('\n')).not.toContain('stale');
  });

  /**
   * ON `console.warn` RATHER THAN `console.log`, and that is the point of the assertion.
   *
   * Two captures of one document were in flight at once. Unlike the collision above - two tabs,
   * whose counters are simply not comparable - this one says the SAME writer's own flushes finished
   * out of order, which is a race and not a fact of life. A line at `log` level is one a reader
   * skips; this one has to accuse, because the fix is upstream of it.
   */
  it("and an OLDER write behind another document's blob reads as stale, accuses, and names both versions", async () => {
    const mine = tagMlsSnapshot(new Uint8Array([2]), 'the-new-path');
    await saveMlsStateEncrypted('user-1', mine);
    store.set(MLS_STATE_VERSION_KEY, 3_000_000); // another tab ran further
    const older = tagMlsSnapshot(new Uint8Array([1]), 'the-old-path');

    const said: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a) => void said.push(a.join(' ')));
    await saveMlsStateEncrypted('user-1', older);
    spy.mockRestore();

    expect(said.join('\n')).toContain('stale');
    expect(said.join('\n')).toContain('<');
    expect(said.join('\n')).not.toContain('collides');
    // WHICH WRITES OVERLAPPED IS THE FINDING: the refused one, the stored one, and what this
    // document last wrote, which is what tells the stored blob is not its own.
    expect(said.join('\n')).toContain('the-old-path');
    expect(said.join('\n')).toContain('v3000000');
    expect(said.join('\n')).toContain(`v${mlsSnapshotVersion(mine)}`);
  });

  /**
   * A VERSION MUST CROSS AN AWAIT BY PROPAGATION, NEVER BY A FRESH TAG.
   *
   * The key-package path handed a snapshot to a worker, kept it for up to 30 s, and tagged the
   * result when it came back - dating a stale capture to now. A checkpoint captured DURING that
   * window then carried a lower number and was refused against it, so the guard dropped the fresher
   * state and kept the older one. This pins the shape rather than the call site.
   */
  it('a derived blob tagged AFTER an await outranks a fresher capture - propagation is the fix', async () => {
    const captured = tagMlsSnapshot(new Uint8Array([1]), 'slow-path capture');
    // ... time passes, and a checkpoint of genuinely newer state is captured and written ...
    const fresher = tagMlsSnapshot(new Uint8Array([2]), 'checkpoint');
    await saveMlsStateEncrypted('user-1', fresher);

    // The wrong way: the slow path's result is numbered when it comes back.
    const lateTagged = tagMlsSnapshot(new Uint8Array([3]), 'slow-path result');
    expect(mlsSnapshotVersion(lateTagged)!).toBeGreaterThan(mlsSnapshotVersion(fresher)!);
    await saveMlsStateEncrypted('user-1', lateTagged);
    // The older state won, which is exactly the inversion the guard exists to prevent.
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([3]));

    // The right way: the result carries the CAPTURE's number, so the fresher checkpoint outranks it.
    const propagated = propagateMlsSnapshotVersion(captured, new Uint8Array([4]));
    expect(mlsSnapshotVersion(propagated)!).toBeLessThan(mlsSnapshotVersion(fresher)!);
  });

  it('always writes untagged bytes (restore / migration have no concurrency)', async () => {
    await saveMlsStateEncrypted('user-1', new Uint8Array([5, 5]));
    expect(store.get(MLS_STATE_ENCRYPTED_KEY)).toEqual(new Uint8Array([5, 5]));
  });

  /**
   * A ZERO-LENGTH STATE IS AN ABSENT STATE, AND ONLY ONE OF THE TWO RUNTIMES SAID SO.
   *
   * `load_mls_state` on the native side guards `res.length > 0` before returning bytes; the
   * IndexedDB path resolved `req.result ?? null` and then tested the result for truthiness - and an
   * empty `Uint8Array` is truthy. So a web device whose stored state had been written short (an
   * interrupted flush, a quota failure) reported a state that EXISTS and is empty.
   *
   * What that costs is not cosmetic. The caller sets `noFreshStart: !!bytes`, whose whole purpose is
   * to stop a device with real history from silently starting over - so an empty state armed the
   * guard against itself: init is handed zero bytes and forbidden to start fresh, and the login
   * fails with no path back. The same damage on the phone re-enrols cleanly.
   */
  it('treats a zero-length stored state as ABSENT, like the native path does', async () => {
    store.set(MLS_STATE_ENCRYPTED_KEY, new Uint8Array(0));
    expect(await loadMlsState('user-empty')).toBeNull();
  });

  it('loadMlsState seeds the counter from the stored version', async () => {
    const tagged = tagMlsSnapshot(new Uint8Array([8]));
    await saveMlsStateEncrypted('user-2', tagged);
    const storedVersion = store.get(MLS_STATE_VERSION_KEY) as number;
    await loadMlsState('user-2');
    // After seeding from the stored version, the next tag must exceed it.
    const next = tagMlsSnapshot(new Uint8Array([9]));
    expect(mlsSnapshotVersion(next)!).toBeGreaterThan(storedVersion);
  });
});
