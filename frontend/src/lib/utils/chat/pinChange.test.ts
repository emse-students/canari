/**
 * The device key change, exercised against the REAL IndexedDB backend (fake-indexeddb): the
 * re-seal reads and compare-and-swaps rows through `getSealedPayloads` / `swapSealedPayloads`, and a
 * hand-written double of those two would be exactly the part that could be wrong silently.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import { decryptData } from '$lib/encryption';
import type { OutboxEntry, SealedStore, StoredGraineSession, StoredMessage } from '$lib/db';

const storageForUser = new Map<string, IndexedDbStorage>();
vi.mock('$lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/db')>()),
  getStorage: async (userId: string) => storageForUser.get(userId)!,
}));
vi.mock('$lib/utils/deviceKeyVault', () => ({
  saveDeviceKey: vi.fn().mockResolvedValue(undefined),
  clearDeviceKeyAndWrapKey: vi.fn(),
}));

const { DeviceKeyMismatchError, performPinChange, resealDeviceKeyStores } =
  await import('./pinChange');

const OLD = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NEW = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const WRONG = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';
const SEED = 'c2VlZC1vbmUtdGhpcnR5LXR3by1ieXRlcy0wMDAwMDA=';

let dbCounter = 0;

async function freshStorage(): Promise<IndexedDbStorage> {
  const storage = new IndexedDbStorage(`pin-change-test-${dbCounter++}`);
  await storage.init();
  return storage;
}

function message(id: string): StoredMessage {
  return {
    id,
    conversationId: 'conv-1',
    senderId: 'alice',
    content: `{"type":"text","body":"${id}"}`,
    timestamp: 1_700_000_000_000 + Number(id.replace(/\D/g, '') || 0),
  };
}

function session(sessionId: string): StoredGraineSession {
  return {
    workspaceId: 'w1',
    channelId: 'c1',
    sessionId,
    senderId: 'u1',
    seedB64: SEED,
    firstIndex: 0,
    createdAt: 1_700_000_000_000,
    sentCount: 3,
  };
}

function queued(id: string): OutboxEntry {
  return {
    id,
    conversationId: 'conv-1',
    sentAt: 1_700_000_000_000,
    kind: 'text',
    status: 'pending',
    attempts: 0,
    createdAt: 1_700_000_000_000,
    text: `queued ${id}`,
  } as OutboxEntry;
}

/** A device holding some of everything the device key seals, all under `key`. */
async function populated(key: string, messages = 3): Promise<IndexedDbStorage> {
  const storage = await freshStorage();
  await storage.saveMessages(
    Array.from({ length: messages }, (_, i) => message(`m${i}`)),
    key
  );
  await storage.saveGraineSession(session('s1'), key);
  await storage.saveGraineSession(session('s2'), key);
  await storage.saveOutboxEntry(queued('o1'), key);
  return storage;
}

/** Which key every sealed row of `store` opens under. */
async function keysOf(storage: IndexedDbStorage, store: SealedStore): Promise<string[]> {
  const rows = await storage.getSealedPayloads(store);
  return Promise.all(
    rows.map(async (r) => {
      for (const [name, key] of [
        ['old', OLD],
        ['new', NEW],
      ] as const) {
        if (
          await decryptData(r.cipherText, r.iv, key).then(
            () => true,
            () => false
          )
        )
          return name;
      }
      return 'neither';
    })
  );
}

async function everyRowUnder(storage: IndexedDbStorage, which: 'old' | 'new'): Promise<void> {
  for (const store of ['messages', 'graine', 'outbox'] as const) {
    const keys = await keysOf(storage, store);
    expect(keys.length).toBeGreaterThan(0);
    expect(
      keys.every((k) => k === which),
      `${store}: ${keys.join(',')}`
    ).toBe(true);
  }
}

describe('resealDeviceKeyStores', () => {
  it('moves messages, Graine seeds AND the outbox to the new key, payloads intact', async () => {
    const storage = await populated(OLD);

    const report = await resealDeviceKeyStores(storage, OLD, NEW);

    expect(report.resealed).toEqual({ messages: 3, graine: 2, outbox: 1 });
    await everyRowUnder(storage, 'new');
    expect(await storage.getGraineSession('s1', NEW)).toEqual(session('s1'));
    expect((await storage.getMessages('conv-1', NEW)).map((m) => m.content)).toEqual(
      ['m0', 'm1', 'm2'].map((id) => message(id).content)
    );
    expect((await storage.getOutboxEntry('o1', NEW))?.text).toBe('queued o1');
  });

  it('refuses a wrong old key with a typed error and writes NOTHING', async () => {
    const storage = await populated(OLD);
    const before = await storage.getSealedPayloads('graine');

    const err = await resealDeviceKeyStores(storage, WRONG, NEW).catch((e) => e);

    expect(err).toBeInstanceOf(DeviceKeyMismatchError);
    expect(await storage.getSealedPayloads('graine')).toEqual(before);
    await everyRowUnder(storage, 'old');
  });

  it('finishes a run killed half way: a row already under the new key is done, not damaged', async () => {
    const storage = await populated(OLD, 450);
    // The kill: the second write batch never lands.
    const real = storage.swapSealedPayloads.bind(storage);
    let calls = 0;
    const spy = vi.spyOn(storage, 'swapSealedPayloads').mockImplementation(async (store, swaps) => {
      if (++calls === 2) throw new Error('killed');
      return real(store, swaps);
    });
    await expect(resealDeviceKeyStores(storage, OLD, NEW)).rejects.toThrow('killed');
    spy.mockRestore();
    // Half moved: some messages under each key, and the seeds not reached at all.
    const half = await keysOf(storage, 'messages');
    expect(half).toContain('old');
    expect(half).toContain('new');
    expect(await keysOf(storage, 'graine')).toEqual(['old', 'old']);

    const report = await resealDeviceKeyStores(storage, OLD, NEW);

    expect(report.alreadyNew).toBe(200);
    expect(report.unreadable).toBe(0);
    await everyRowUnder(storage, 'new');
  });

  it('accepts a store that is already entirely under the new key (a retry after the last batch)', async () => {
    const storage = await populated(NEW);

    const report = await resealDeviceKeyStores(storage, OLD, NEW);

    expect(report.alreadyNew).toBe(6);
    await everyRowUnder(storage, 'new');
  });

  it('leaves a row that opens under neither key exactly as it is, and moves the rest', async () => {
    const storage = await populated(OLD);
    await storage.saveGraineSession(session('damaged'), WRONG);
    const damaged = (await storage.getSealedPayloads('graine')).find((r) => r.id === 'damaged')!;

    const report = await resealDeviceKeyStores(storage, OLD, NEW);

    expect(report.unreadable).toBe(1);
    expect(report.resealed.graine).toBe(2);
    const after = (await storage.getSealedPayloads('graine')).find((r) => r.id === 'damaged')!;
    expect(after).toEqual(damaged);
  });

  it('never brings back an outbox row deleted (sent) between the read and the write', async () => {
    const storage = await populated(OLD);
    const read = storage.getSealedPayloads.bind(storage);
    vi.spyOn(storage, 'getSealedPayloads').mockImplementation(async (store) => {
      const rows = await read(store);
      if (store === 'outbox') await storage.deleteOutboxEntry('o1');
      return rows;
    });

    const report = await resealDeviceKeyStores(storage, OLD, NEW);

    expect(report.changedSinceRead).toBe(1);
    expect(await storage.getOutboxEntry('o1', NEW)).toBeNull();
  });

  it('is a no-op when old and new device key are identical', async () => {
    const storage = await populated(OLD);
    const before = await storage.getSealedPayloads('messages');

    await resealDeviceKeyStores(storage, OLD, OLD);

    expect(await storage.getSealedPayloads('messages')).toEqual(before);
  });
});

describe('both PIN paths go through performPinChange', () => {
  // `recoverPinImpl` and `changePinImpl` run over dozens of module-level dependencies (token, salt,
  // verifier, login), so WHICH path they take is pinned in the source, as `signOutEndsLiveSession`
  // does; WHAT that path does is the behaviour tested below. The recovery used to call
  // `reencryptLocalMessages` on its own and never re-sealed a seed.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const sessionAuth = read('../../composables/session/sessionAuth.ts');
  const body = (head: string) => {
    const from = sessionAuth.indexOf(head);
    expect(from).toBeGreaterThan(-1);
    return sessionAuth.slice(from, sessionAuth.indexOf('\n}\n', from));
  };

  it.each(['export async function recoverPinImpl(', 'export async function changePinImpl('])(
    '%s re-seals through performPinChange and nothing else',
    (head) => {
      const fn = body(head);
      expect(fn).toContain('await performPinChange(');
      expect(fn).not.toMatch(/reencrypt|saveGraineSession|saveMessages|swapSealedPayloads/);
    }
  );
});

describe('performPinChange - the one path of the change AND the recovery', () => {
  function options(userId: string, resealMlsState: (k: string) => Promise<void>) {
    return { userId, resealMlsState, setDeviceKey: vi.fn(), log: () => {} };
  }

  it('recovery with seeds present: every seed opens under the new key afterwards', async () => {
    // The defect: `recoverPinImpl` moved the messages and the MLS state and left every seed under
    // the old key - channel history this device could no longer open, and the server holds none.
    storageForUser.set('u-recover', await populated(OLD));
    const recoverAndRekey = vi.fn().mockResolvedValue(true);
    const opts = options('u-recover', async (k) => {
      if (!(await recoverAndRekey('u-recover', OLD, k))) throw new Error('old PIN');
    });

    await performPinChange(opts, OLD, NEW);

    const storage = storageForUser.get('u-recover')!;
    await everyRowUnder(storage, 'new');
    expect(await storage.getGraineSession('s2', NEW)).toEqual(session('s2'));
    expect(opts.setDeviceKey).toHaveBeenCalledWith(NEW);
  });

  it('re-seals the stores BEFORE the MLS state, so a kill in the stores leaves the recovery open', async () => {
    const storage = await populated(OLD);
    storageForUser.set('u-order', storage);
    const order: string[] = [];
    const real = storage.swapSealedPayloads.bind(storage);
    vi.spyOn(storage, 'swapSealedPayloads').mockImplementation(async (store, swaps) => {
      order.push(store);
      return real(store, swaps);
    });

    await performPinChange(
      options('u-order', async () => {
        order.push('mls');
      }),
      OLD,
      NEW
    );

    expect(order).toEqual(['messages', 'graine', 'outbox', 'mls']);
  });

  it('a failure in the stores never reaches the MLS state or the session key', async () => {
    const storage = await populated(OLD);
    storageForUser.set('u-kill', storage);
    vi.spyOn(storage, 'swapSealedPayloads').mockRejectedValueOnce(new Error('disk full'));
    const resealMls = vi.fn().mockResolvedValue(undefined);
    const opts = options('u-kill', resealMls);

    await expect(performPinChange(opts, OLD, NEW)).rejects.toThrow('disk full');

    expect(resealMls).not.toHaveBeenCalled();
    expect(opts.setDeviceKey).not.toHaveBeenCalled();
    // And the same two keys finish it - which is what the recovery does next.
    await performPinChange(opts, OLD, NEW);
    await everyRowUnder(storage, 'new');
  });

  it('a wrong old key is refused before anything moves, MLS state included', async () => {
    storageForUser.set('u-wrong', await populated(OLD));
    const resealMls = vi.fn().mockResolvedValue(undefined);

    await expect(
      performPinChange(options('u-wrong', resealMls), WRONG, NEW)
    ).rejects.toBeInstanceOf(DeviceKeyMismatchError);

    expect(resealMls).not.toHaveBeenCalled();
    await everyRowUnder(storageForUser.get('u-wrong')!, 'old');
  });
});
