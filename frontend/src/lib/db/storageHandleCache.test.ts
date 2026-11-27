/**
 * `getStorage` HANDS BACK ONE OPEN STORE PER USER, AND NEVER A CLOSED ONE.
 *
 * `init()` is not a cheap read: it opens the database and replays PRAGMA plus every CREATE TABLE
 * and CREATE INDEX. A cold Android launch called `getStorage` twice - once for the conversations
 * panel, once from the login flow - and paid that sequence twice, the second time ON THE PATH TO
 * THE BIOMETRIC PROMPT, which is the delay this cache exists to remove (Pixel 6a, 2026-09-15).
 *
 * A cache of handles is only safe while it can tell a live handle from a dead one. `close()` is
 * reachable from the revoked-device wipe, and a cache blind to it would answer the NEXT caller with
 * a store whose connection is gone - every call on it failing for a reason the caller could not
 * name. So the three facts pinned here are the three the cache can get wrong.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));

/** Opens counted across the suite, so "did it open again?" is answerable rather than inferred. */
let opens = 0;
/** Set to make the NEXT open fail, the way a full disk does. */
let failNextOpen = false;
/** When set, `close()` waits for it - a close still in flight while a caller opens again. */
let closeGate: Promise<void> | null = null;
/** The order `init`/`close` ran in, per call. */
const trace: string[] = [];

vi.mock('./sqlite', () => ({
  SqliteStorage: class {
    db: object | null = null;
    get isOpen(): boolean {
      return this.db !== null;
    }
    async init(): Promise<void> {
      opens++;
      trace.push('init');
      if (failNextOpen) {
        failNextOpen = false;
        throw new Error('database or disk is full');
      }
      this.db = {};
    }
    async close(): Promise<void> {
      trace.push('close-start');
      await closeGate;
      trace.push('close-end');
      this.db = null;
    }
  },
}));

describe('getStorage shares one open handle per user', () => {
  // THE FIRST `import('../db')` TRANSFORMS THE WHOLE STORAGE MODULE GRAPH, and that cost landed inside
  // whichever test ran first: alone it is ~5 s of a 7 s file, so under a full-suite load the first
  // test crossed its 5 s budget while asserting nothing slow (a push of fix/seal-group-names,
  // 2026-11-17). Paid once here, in a hook whose budget names it, so each test runs in ~70 ms.
  // `vi.resetModules()` below still re-EVALUATES the module per test from the transformed cache,
  // which is what the tests need.
  beforeAll(async () => {
    await import('../db');
  }, 60_000);

  beforeEach(() => {
    opens = 0;
    failNextOpen = false;
    closeGate = null;
    trace.length = 0;
    vi.resetModules();
  });

  it('opens once for repeated calls, and once more per distinct user', async () => {
    const { getStorage } = await import('../db');

    const first = await getStorage('alice');
    const second = await getStorage('alice');

    expect(second).toBe(first);
    expect(opens).toBe(1);

    await getStorage('bob');
    expect(opens).toBe(2);
  });

  it('joins a single open when two callers race a cold start', async () => {
    const { getStorage } = await import('../db');

    const [a, b] = await Promise.all([getStorage('alice'), getStorage('alice')]);

    expect(b).toBe(a);
    expect(opens).toBe(1);
  });

  it('never hands back a handle the wipe has closed', async () => {
    const { getStorage } = await import('../db');

    const closed = await getStorage('alice');
    await closed.close();

    const reopened = await getStorage('alice');

    expect(reopened).not.toBe(closed);
    expect(reopened.isOpen).toBe(true);
    expect(opens).toBe(2);
  });

  it('callers that joined a failed open fail WITH it - none of them starts an open of its own', async () => {
    // 2026-11-25: every caller that had joined a failed open read it as "nothing cached" and started
    // its own, all at once - five schema runs side by side, and one dropped the table another had
    // just filled (`docs/wiki/frontend/local-store-rebuild.md`).
    const { getStorage } = await import('../db');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    failNextOpen = true;
    const joiners = Array.from({ length: 5 }, () => getStorage('alice'));
    const settled = await Promise.allSettled(joiners);

    expect(settled.map((s) => s.status)).toEqual(Array(5).fill('rejected'));
    expect(opens).toBe(1);
    expect(error.mock.calls.filter((c) => String(c[0]).includes('did not open'))).toHaveLength(1);
    error.mockRestore();
  });

  it('does not remember a failed open as one', async () => {
    const { getStorage } = await import('../db');

    failNextOpen = true;
    await expect(getStorage('alice')).rejects.toThrow('disk is full');

    // A transient failure must not become permanent for the rest of the session.
    const recovered = await getStorage('alice');
    expect(recovered.isOpen).toBe(true);
    expect(opens).toBe(2);
  });

  it('an open never starts while a close of the same file is still in flight', async () => {
    // The plugin shares one pool per file: the older handle's close would shut the newer open's pool.
    const { getStorage, closeCachedStore } = await import('../db');
    await getStorage('alice');
    let release!: () => void;
    closeGate = new Promise<void>((r) => (release = r));
    trace.length = 0;

    const closing = closeCachedStore('alice');
    const reopening = getStorage('alice');
    await Promise.resolve();
    release();
    await Promise.all([closing, reopening]);

    expect(trace).toEqual(['close-start', 'close-end', 'init']);
    expect((await reopening).isOpen).toBe(true);
  });

  it('a second close joins the first instead of answering that nothing is open', async () => {
    const { getStorage, closeCachedStore } = await import('../db');
    await getStorage('alice');
    expect(await Promise.all([closeCachedStore('alice'), closeCachedStore('alice')])).toEqual([
      true,
      true,
    ]);
  });
});
