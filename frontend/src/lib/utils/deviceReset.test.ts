import { wipeDeviceToFactory } from './deviceReset';

// Mutable, because the two runtimes are exactly what the branch below is about.
let tauri = false;
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => tauri }));

const invokeMock = vi.fn(async (_cmd: string) => {});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string) => invokeMock(cmd) }));
// Both entry points are mocked, because WHICH one the wipe reaches is the assertion: `disable`
// raises an Android activity and can be refused, `forget` asks nothing.
/**
 * The MLS connection close, recorded in the SAME order array as the deletes - because the property
 * under test is not that it was called, it is that it was called FIRST. `deleteDatabase` does not
 * fail on an open connection, it blocks, so a close that happens afterwards leaves exactly the
 * defect HEAL-REVOKE-5 measured on prod: a revoked device that kept its MLS store while every log
 * said the wipe had run.
 */
const closeMlsDbMock = vi.fn(async () => {});
vi.mock('$lib/utils/hex', () => ({ closeMlsDb: () => closeMlsDbMock() }));

/**
 * The message-store connections, closed the same way and asserted the same way: BEFORE the deletes.
 *
 * `getStorage()` is a factory, so a page holds as many connections as it has readers - `/posts` was
 * measured holding two on prod on 2026-08-30 - and the wipe used to take a `closeStorage` callback
 * that could only ever close the one the caller happened to have. HEAL-REVOKE-9 caught the rest:
 * `delete deferred`, then `1 store(s) SURVIVED the wipe`.
 */
const closeStoresMock = vi.fn(async () => 2);
vi.mock('$lib/db', () => ({ closeOpenIndexedDbStores: () => closeStoresMock() }));

const forgetMock = vi.fn(async (_alias?: string) => {});
const disableMock = vi.fn(async (_alias?: string) => {});
vi.mock('$lib/services/biometric', () => ({
  BiometricService: { forget: forgetMock, disable: disableMock },
}));

/**
 * A revoked device is one its owner declared lost or stolen, so what must remain afterwards is an
 * app that has never been used - not an app that merely forgot its MLS state. These pin the two
 * properties that make that true: everything is cleared, and one store failing does not stop the
 * rest (a wipe that stops half way and reports success is the failure mode worth guarding).
 */
describe('wipeDeviceToFactory', () => {
  const deleted: string[] = [];
  // Stateful on purpose: the survey re-reads this after the wipe, so a fake that keeps answering
  // with the databases it was asked to delete would report every wipe as having left them behind.
  let present: string[] = [];

  beforeEach(() => {
    deleted.length = 0;
    present = ['CanariDB_u1', 'SomethingElse'];
    localStorage.setItem('canari_theme', 'dark');
    sessionStorage.setItem('anything', '1');

    vi.stubGlobal('indexedDB', {
      databases: async () => present.map((name) => ({ name })),
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        deleted.push(name);
        present = present.filter((n) => n !== name);
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
    vi.stubGlobal('caches', {
      keys: async () => ['media-v1', 'app-shell'],
      delete: async (n: string) => {
        deleted.push(`cache:${n}`);
        return true;
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('closes the MLS connection BEFORE deleting anything, or the delete only blocks', async () => {
    const order: string[] = [];
    closeMlsDbMock.mockImplementationOnce(async () => {
      order.push('close');
    });
    vi.stubGlobal('indexedDB', {
      databases: async () => present.map((name) => ({ name })),
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        order.push(`delete:${name}`);
        present = present.filter((n) => n !== name);
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });

    await wipeDeviceToFactory();

    expect(order[0]).toBe('close');
    expect(order).toContain('delete:CanariDB_u1');
  });

  it('reports a delete that FAILED, which used to be indistinguishable from one that worked', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    vi.stubGlobal('indexedDB', {
      databases: async () => present.map((name) => ({ name })),
      deleteDatabase: (_name: string) => {
        const req: Record<string, unknown> = { error: new Error('QuotaExceeded') };
        queueMicrotask(() => (req.onerror as () => void)?.());
        return req;
      },
    });

    await wipeDeviceToFactory();

    expect(errors.some((e) => e.includes('could not delete CanariDB_u1'))).toBe(true);
    // And the survey still speaks for itself: the database is reported as a survivor, because the
    // delete never happened. One accusation is not the other - the log says WHY, the survey WHAT.
    expect(errors.some((e) => e.includes('SURVIVED') && e.includes('CanariDB_u1'))).toBe(true);
  });

  it('clears preferences, caches and the app databases', async () => {
    const failures = await wipeDeviceToFactory();

    expect(failures).toEqual([]);
    expect(localStorage.getItem('canari_theme')).toBeNull();
    expect(sessionStorage.getItem('anything')).toBeNull();
    expect(deleted).toContain('cache:media-v1');
    expect(deleted).toContain('cache:app-shell');
  });

  it("touches only Canari's own databases", async () => {
    await wipeDeviceToFactory();

    expect(deleted).toContain('CanariDB_u1');
    expect(deleted).not.toContain('SomethingElse');
  });

  it('closes every message-store connection before it deletes anything', async () => {
    // The property is the ORDER, not the call: a close that lands after the delete leaves exactly
    // the defect HEAL-REVOKE-9 measured - `deleteDatabase` fires `onblocked` and the store survives.
    const order = deleted;
    closeStoresMock.mockImplementationOnce(async () => {
      order.push('close');
      return 2;
    });

    await wipeDeviceToFactory();

    expect(closeStoresMock).toHaveBeenCalled();
    // `deleted` is appended by the stubbed `deleteDatabase`, so a close recorded into the same
    // array first is the order the defect turned on.
    expect(order[0]).toBe('close');
    expect(order).toContain('CanariDB_u1');
    // And it asks NOTHING of its caller: the connections it must close are ones no caller can see.
    expect(wipeDeviceToFactory.length).toBe(0);
  });

  it('reports the steps that failed instead of stopping at the first one', async () => {
    vi.stubGlobal('caches', {
      keys: async () => {
        throw new Error('cache API unavailable');
      },
      delete: async () => true,
    });

    const failures = await wipeDeviceToFactory();

    // The cache step failed, and the ones after it still ran.
    expect(failures).toEqual(['the cached responses']);
    expect(localStorage.getItem('canari_theme')).toBeNull();
  });

  /**
   * "Nothing of this device remains" was printed, on 2026-08-28, on a revoked device that kept its
   * MLS database and ten localStorage keys: the wipe reported the steps it RAN, and something still
   * running had put the state back. A claim about what is GONE has to be read back to be made.
   */
  it('names what survived instead of claiming an empty device', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(String(args[0])));
    // A store that outlives its own deletion, which is exactly the shape that went unreported.
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'CanariDBMls_u1' }],
      deleteDatabase: () => {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });

    await wipeDeviceToFactory();

    expect(errors.some((e) => e.includes('SURVIVED') && e.includes('CanariDBMls_u1'))).toBe(true);
  });

  it('touches no keystore off a native runtime, because there is none', async () => {
    await wipeDeviceToFactory();

    expect(forgetMock).not.toHaveBeenCalled();
    expect(disableMock).not.toHaveBeenCalled();
  });

  it('claims an empty device only when nothing reads back', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(String(args[0])));

    await wipeDeviceToFactory();

    expect(logs).toContain('[RESET] done - nothing of this device remains');
  });
});

/**
 * The native steps are an ADDITION to the WebView ones, never a replacement.
 *
 * They used to be the two arms of one `if`, so a phone got `mls.bin` and its `.db` files deleted and
 * kept every IndexedDB database in its WebView. That was not theoretical: a Pixel 6a was measured on
 * 2026-08-28 holding a 5.9 MB `CanariDB_<userId>` after the wipe, on a platform whose real message
 * store is SQLite - so the database should not have existed AND could not be removed.
 */
describe('wipeDeviceToFactory on a native runtime', () => {
  const deleted: string[] = [];
  const invoked: string[] = [];
  let present: string[] = [];

  beforeEach(() => {
    tauri = true;
    deleted.length = 0;
    invoked.length = 0;
    forgetMock.mockClear();
    disableMock.mockClear();
    // What a signed-in session leaves behind, and the only record of the keystore alias.
    localStorage.setItem('mls_device_id_u1', 'tauri-u1-abcd');
    present = ['CanariDB_u1'];
    vi.stubGlobal('indexedDB', {
      databases: async () => present.map((name) => ({ name })),
      deleteDatabase: (name: string) => {
        const req: Record<string, unknown> = {};
        deleted.push(name);
        present = present.filter((n) => n !== name);
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
    vi.stubGlobal('caches', { keys: async () => [], delete: async () => true });
    invokeMock.mockImplementation(async (cmd: string) => {
      invoked.push(cmd);
    });
  });

  afterEach(() => {
    tauri = false;
    vi.unstubAllGlobals();
  });

  it('deletes the WebView databases as well as the native files', async () => {
    const failures = await wipeDeviceToFactory();

    expect(failures).toEqual([]);
    expect(invoked).toContain('delete_mls_state');
    expect(invoked).toContain('clear_app_data');
    // The half that was missing: a phone kept this.
    expect(deleted).toContain('CanariDB_u1');
  });

  it('does not claim an empty device while a WebView database survives', async () => {
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
    // A database that outlives its own deletion - which is what the phone looked like.
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'CanariDB_u1' }],
      deleteDatabase: () => {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });

    await wipeDeviceToFactory();

    const said = errors.flat().join(' ');
    expect(said).toContain('SURVIVED');
    spy.mockRestore();
  });

  /**
   * A revoked device may be in the hands of whoever took it, so the wipe must not be refusable. It
   * called `BiometricService.disable()`, whose whole contract is a prompt that can be cancelled -
   * and on a Pixel 6a on 2026-08-28 that prompt did not even get as far as being cancelled: the
   * activity failed to inflate and killed the process 55 ms in.
   */
  it('never asks the holder of a revoked device for a fingerprint', async () => {
    await wipeDeviceToFactory();

    expect(disableMock).not.toHaveBeenCalled();
    expect(forgetMock).toHaveBeenCalled();
  });

  /**
   * The step was named "the biometric key" and deleted none: it passed no alias, and without one
   * `deleteKeyBytes` is never called. The alias is rebuilt from the device's own record so that
   * both callers sweep it - the login page's reset button has no session to ask.
   */
  it('deletes the keystore entry the device recorded, not just the flag', async () => {
    await wipeDeviceToFactory();

    expect(forgetMock).toHaveBeenCalledWith('mls_device_key_u1_tauri-u1-abcd');
  });

  /**
   * Ordering is a property here, not a style choice: `step()` catches a rejected promise, and a
   * native activity that fails to inflate is not a rejected promise but a dead process. The one
   * step that can raise an activity therefore runs after every step that cannot.
   */
  it('clears the WebView stores before the step that could kill the process', async () => {
    const order: string[] = [];
    forgetMock.mockImplementation(async () => void order.push('biometric'));
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'CanariDB_u1' }],
      deleteDatabase: () => {
        const req: Record<string, unknown> = {};
        order.push('databases');
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    });
    vi.stubGlobal('caches', {
      keys: async () => ['app-shell'],
      delete: async () => {
        order.push('caches');
        return true;
      },
    });

    await wipeDeviceToFactory();

    expect(order.indexOf('biometric')).toBeGreaterThan(order.indexOf('databases'));
    expect(order.indexOf('biometric')).toBeGreaterThan(order.indexOf('caches'));
    forgetMock.mockImplementation(async () => {});
  });
});
