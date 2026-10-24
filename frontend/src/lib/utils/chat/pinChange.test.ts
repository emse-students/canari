/**
 * The device key change, exercised against the REAL IndexedDB backend (fake-indexeddb): the
 * re-seal reads and compare-and-swaps rows through `getSealedPayloads` / `swapSealedPayloads`, and a
 * hand-written double of those two would be exactly the part that could be wrong silently.
 *
 * The storage gate keeps a process-wide map of retired keys, so every test that goes through it
 * uses its OWN pair of keys ({@link keys}) - a key retired by one test must not forward another's.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import { gateStorage } from '$lib/db/deviceKeyGate';
import type { OutboxBlobStore } from '$lib/db/outboxBlob';
import { decryptData } from '$lib/encryption';
import { toBase64 } from '$lib/utils/hex';
import type { IMlsService, StateLoadFailure } from '$lib/mls-client';
import { LocalStateNotReadyError } from '$lib/mls-client/IMlsService';
import type {
  IStorage,
  OutboxEntry,
  SealedStore,
  StoredGraineSession,
  StoredMessage,
} from '$lib/db';
import { flushMacrotask } from '../../../test/flush';

const storageForUser = new Map<string, IStorage>();
vi.mock('$lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/db')>()),
  getStorage: async (userId: string) => storageForUser.get(userId)!,
}));
const vault = vi.hoisted(() => ({
  saveDeviceKey: vi.fn().mockResolvedValue(undefined),
  clearDeviceKey: vi.fn(),
  clearDeviceKeyAndWrapKey: vi.fn(),
  retireUnlabelledDeviceKeyIfOwnedBy: vi.fn().mockResolvedValue(false),
}));
vi.mock('$lib/utils/deviceKeyVault', () => vault);

const {
  DeviceKeyMismatchError,
  KeyChangeInterruptedError,
  LocalStateUnopenableError,
  LocalStateUnreadableNowError,
  dropStoredFeedPages,
  moveSealedStoresOnly,
  performPinChange,
  resealDeviceKeyStores,
} = await import('./pinChange');

const SEED = 'c2VlZC1vbmUtdGhpcnR5LXR3by1ieXRlcy0wMDAwMDA=';

/** A fresh, random device key (32 bytes, base64). */
function key(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/** A fresh old/new/wrong triple, so nothing one test retires at the gate touches another. */
function keys() {
  return { OLD: key(), NEW: key(), WRONG: key() };
}

let dbCounter = 0;

/** The store as the session sees it (through the gate) and as it is behind it. */
async function freshStorage(): Promise<{ raw: IndexedDbStorage; gated: IStorage }> {
  const userId = `pin-change-test-${dbCounter++}`;
  const raw = new IndexedDbStorage(userId);
  await raw.init();
  return { raw, gated: gateStorage(raw, userId) };
}

function message(id: string, body = id): StoredMessage {
  return {
    id,
    conversationId: 'conv-1',
    senderId: 'alice',
    content: `{"type":"text","body":"${body}"}`,
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
  };
}

/** A device holding some of everything the device key seals, all under `k`, written behind the gate. */
async function populated(
  k: string,
  messages = 3
): Promise<{ raw: IndexedDbStorage; gated: IStorage }> {
  const s = await freshStorage();
  await s.raw.saveMessages(
    Array.from({ length: messages }, (_, i) => message(`m${i}`)),
    k
  );
  await s.raw.saveGraineSession(session('s1'), k);
  await s.raw.saveGraineSession(session('s2'), k);
  await s.raw.saveOutboxEntry(queued('o1'), k);
  return s;
}

/** Which of `named` keys every sealed row of `store` opens under ('neither' when none). */
async function keysOf(
  storage: IndexedDbStorage,
  store: SealedStore,
  named: Record<string, string>
): Promise<string[]> {
  const rows = await storage.getSealedPayloads(store);
  return Promise.all(
    rows.map(async (r) => {
      for (const [name, k] of Object.entries(named)) {
        const opens = await decryptData(r.cipherText, r.iv, k).then(
          () => true,
          () => false
        );
        if (opens) return name;
      }
      return 'neither';
    })
  );
}

async function everyRowUnder(storage: IndexedDbStorage, k: string): Promise<void> {
  for (const store of ['messages', 'graine', 'outbox'] as const) {
    const opened = await keysOf(storage, store, { k });
    expect(opened.length).toBeGreaterThan(0);
    expect(
      opened.every((x) => x === 'k'),
      `${store}: ${opened.join(',')}`
    ).toBe(true);
  }
}

/**
 * An MLS client double recording the order of the calls a key change makes. `refusal` is what a
 * key other than `opensWith` gets back - a key refusal unless a test says otherwise.
 */
function fakeMls(
  order: string[] = [],
  opensWith?: string,
  refusal: StateLoadFailure = 'undecryptable'
): IMlsService {
  return {
    openLocalStateWithKey: vi.fn(async (_u: string, k: string) => {
      order.push('mls-open');
      return opensWith === undefined || k === opensWith
        ? { opened: true }
        : { opened: false, cause: refusal };
    }),
    pointUnattendedUnlockAt: vi.fn(async () => {
      order.push('keystore');
      return true;
    }),
    changeDeviceKey: vi.fn(async () => {
      order.push('mls-reseal');
    }),
  } as unknown as IMlsService;
}

function options(userId: string, mls: IMlsService, storedMlsState?: Uint8Array) {
  return { userId, mls, storedMlsState, setDeviceKey: vi.fn(), log: () => {} };
}

describe('resealDeviceKeyStores', () => {
  it('moves messages, Graine seeds AND the outbox to the new key, payloads intact', async () => {
    const { OLD, NEW } = keys();
    const { raw } = await populated(OLD);

    const report = await resealDeviceKeyStores(raw, OLD, NEW);

    expect(report.resealed).toEqual({ messages: 3, graine: 2, outbox: 1 });
    await everyRowUnder(raw, NEW);
    expect(await raw.getGraineSession('s1', NEW)).toEqual(session('s1'));
    expect((await raw.getMessages('conv-1', NEW)).map((m) => m.content)).toEqual(
      ['m0', 'm1', 'm2'].map((id) => message(id).content)
    );
    expect((await raw.getOutboxEntry('o1', NEW))?.text).toBe('queued o1');
  });

  it('finishes a run killed half way: a row already under the new key is done, not damaged', async () => {
    const { OLD, NEW } = keys();
    const { raw } = await populated(OLD, 5);
    // The kill: the second write batch never lands.
    const real = raw.swapSealedPayloads.bind(raw);
    let calls = 0;
    const spy = vi.spyOn(raw, 'swapSealedPayloads').mockImplementation(async (store, swaps) => {
      if (++calls === 2) throw new Error('killed');
      return real(store, swaps);
    });
    await expect(resealDeviceKeyStores(raw, OLD, NEW, { batchSize: 2 })).rejects.toThrow('killed');
    spy.mockRestore();
    const half = await keysOf(raw, 'messages', { old: OLD, new: NEW });
    expect(half).toContain('old');
    expect(half).toContain('new');
    expect(await keysOf(raw, 'graine', { old: OLD, new: NEW })).toEqual(['old', 'old']);

    const report = await resealDeviceKeyStores(raw, OLD, NEW, { batchSize: 2 });

    expect(report.alreadyNew).toBe(2);
    expect(report.unreadable).toBe(0);
    await everyRowUnder(raw, NEW);
  });

  it('a row under an OLDER key is left as it is and refuses nothing: the old key was proven elsewhere', async () => {
    // A seed the pre-fix recovery stranded under K0, next to rows under the right old key.
    const { OLD, NEW, WRONG: K0 } = keys();
    const { raw } = await populated(OLD);
    await raw.saveGraineSession(session('stranded'), K0);
    const stranded = (await raw.getSealedPayloads('graine')).find((r) => r.id === 'stranded')!;

    const report = await resealDeviceKeyStores(raw, OLD, NEW);

    expect(report.unreadable).toBe(1);
    expect(report.resealed.graine).toBe(2);
    expect((await raw.getSealedPayloads('graine')).find((r) => r.id === 'stranded')).toEqual(
      stranded
    );
  });

  it('even EVERY row unreadable is not a refusal - only the MLS state decides the old key', async () => {
    const { NEW, WRONG: K0 } = keys();
    const { raw } = await populated(K0);

    const report = await resealDeviceKeyStores(raw, key(), NEW);

    expect(report.unreadable).toBe(6);
    expect(report.resealed).toEqual({ messages: 0, graine: 0, outbox: 0 });
  });

  it('never brings back an outbox row deleted (sent) between the read and the write', async () => {
    const { OLD, NEW } = keys();
    const { raw } = await populated(OLD);
    const read = raw.getSealedPayloads.bind(raw);
    vi.spyOn(raw, 'getSealedPayloads').mockImplementation(async (store) => {
      const rows = await read(store);
      if (store === 'outbox') await raw.deleteOutboxEntry('o1');
      return rows;
    });

    const report = await resealDeviceKeyStores(raw, OLD, NEW);

    expect(report.changedSinceRead).toBe(1);
    expect(await raw.getOutboxEntry('o1', NEW)).toBeNull();
  });

  it('is a no-op when old and new device key are identical', async () => {
    const { OLD } = keys();
    const { raw } = await populated(OLD);
    const before = await raw.getSealedPayloads('messages');

    await resealDeviceKeyStores(raw, OLD, OLD);

    expect(await raw.getSealedPayloads('messages')).toEqual(before);
  });
});

describe('swapSealedPayloads - the COMPARE half of the compare-and-swap', () => {
  it('leaves a row that no longer holds the expected ciphertext exactly as it is', async () => {
    const { OLD } = keys();
    const { raw } = await populated(OLD);
    const [row] = await raw.getSealedPayloads('graine');
    const stale = row!.cipherText.slice();
    stale[0] ^= 0xff;

    const swapped = await raw.swapSealedPayloads('graine', [
      { id: row!.id, expected: stale, iv: new Uint8Array(12), cipherText: new Uint8Array([1, 2]) },
    ]);

    expect(swapped).toBe(0);
    expect((await raw.getSealedPayloads('graine')).find((r) => r.id === row!.id)).toEqual(row);
  });

  it('swaps the row that still holds it, and only that row', async () => {
    const { OLD } = keys();
    const { raw } = await populated(OLD);
    const [first, second] = await raw.getSealedPayloads('graine');
    const next = { iv: new Uint8Array(12).fill(7), cipherText: new Uint8Array([9, 9, 9]) };

    const swapped = await raw.swapSealedPayloads('graine', [
      { id: first!.id, expected: first!.cipherText, ...next },
    ]);

    expect(swapped).toBe(1);
    const after = await raw.getSealedPayloads('graine');
    expect(after.find((r) => r.id === first!.id)).toEqual({ id: first!.id, ...next });
    expect(after.find((r) => r.id === second!.id)).toEqual(second);
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

  it('the change asks whether this tab may change the key BEFORE the server rotates the verifier', () => {
    // A follower's re-seal is refused by the version guard (`pinChange.followerTab.test.ts`): asked
    // after the server took the new PIN, the refusal would still cost the user a recovery.
    const fn = body('export async function changePinImpl(');
    const guard = fn.indexOf('thisTabMayChangeDeviceKey(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fn.indexOf('/api/mls/security/pin-change'));
    expect(guard).toBeLessThan(fn.indexOf('await performPinChange('));
  });

  it('the recovery hands performPinChange the STORED state, the change does not', () => {
    expect(body('export async function recoverPinImpl(')).toContain('storedMlsState: state');
    expect(body('export async function changePinImpl(')).not.toContain('storedMlsState');
  });
});

describe('performPinChange - the one path of the change AND the recovery', () => {
  it('recovery with seeds present: every seed opens under the new key afterwards', async () => {
    // The defect: `recoverPinImpl` moved the messages and the MLS state and left every seed under
    // the old key - channel history this device could no longer open, and the server holds none.
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-recover', s.gated);
    const opts = options('u-recover', fakeMls([], OLD), new Uint8Array([1]));

    await performPinChange(opts, OLD, NEW);

    await everyRowUnder(s.raw, NEW);
    expect(await s.raw.getGraineSession('s2', NEW)).toEqual(session('s2'));
    expect(opts.setDeviceKey).toHaveBeenCalledWith(NEW);
  });

  it('a wrong old PIN is decided by the MLS state, before ANYTHING moves - unlock key included', async () => {
    const { OLD, NEW, WRONG } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-wrong', s.gated);
    const mls = fakeMls([], OLD);
    vault.saveDeviceKey.mockClear();

    await expect(
      performPinChange(options('u-wrong', mls, new Uint8Array([1])), WRONG, NEW)
    ).rejects.toBeInstanceOf(DeviceKeyMismatchError);

    expect(mls.pointUnattendedUnlockAt).not.toHaveBeenCalled();
    expect(vault.saveDeviceKey).not.toHaveBeenCalled();
    expect(mls.changeDeviceKey).not.toHaveBeenCalled();
    await everyRowUnder(s.raw, OLD);
  });

  it.each(['mismatch', 'unknown', 'keystore_unavailable'] as const)(
    'a state no PIN opens (%s) is NOT "old PIN incorrect", and nothing moves',
    async (refusal) => {
      const { OLD, NEW, WRONG } = keys();
      const s = await populated(OLD);
      storageForUser.set(`u-${refusal}`, s.gated);
      const mls = fakeMls([], WRONG, refusal);

      const failure = await performPinChange(
        options(`u-${refusal}`, mls, new Uint8Array([1])),
        OLD,
        NEW
      ).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(LocalStateUnopenableError);
      expect(failure).not.toBeInstanceOf(DeviceKeyMismatchError);
      expect(mls.pointUnattendedUnlockAt).not.toHaveBeenCalled();
      await everyRowUnder(s.raw, OLD);
    }
  );

  it('a state unreadable RIGHT NOW is neither "old PIN incorrect" nor "damaged, reset"', async () => {
    // A transient WebCrypto fault used to land in LocalStateUnopenableError, whose message sends the
    // user to a destructive reset of a state nothing showed to be broken.
    const { OLD, NEW, WRONG } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-unreadable-now', s.gated);
    const mls = fakeMls([], WRONG, 'unreadable_now');

    const failure = await performPinChange(
      options('u-unreadable-now', mls, new Uint8Array([1])),
      OLD,
      NEW
    ).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(LocalStateUnreadableNowError);
    expect(failure).not.toBeInstanceOf(LocalStateUnopenableError);
    expect(failure).not.toBeInstanceOf(DeviceKeyMismatchError);
    expect(mls.pointUnattendedUnlockAt).not.toHaveBeenCalled();
    await everyRowUnder(s.raw, OLD);
  });

  it('a state that OPENED but could not be made ready moves nothing, and keeps its type', async () => {
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-not-ready', s.gated);
    const mls = fakeMls();
    vi.mocked(mls.openLocalStateWithKey).mockRejectedValueOnce(
      new LocalStateNotReadyError(new Error('lister_groupes failed'))
    );

    const failure = await performPinChange(
      options('u-not-ready', mls, new Uint8Array([1])),
      OLD,
      NEW
    ).catch((e: unknown) => e);

    // Typed, so the recovery reports a retry rather than "old PIN incorrect" (sessionAuth).
    expect(failure).toBeInstanceOf(LocalStateNotReadyError);
    expect(mls.pointUnattendedUnlockAt).not.toHaveBeenCalled();
    expect(mls.changeDeviceKey).not.toHaveBeenCalled();
    await everyRowUnder(s.raw, OLD);
  });

  it('a THROW in the MLS re-seal is typed too: the stores moved, the session must end', async () => {
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-mls-throw', s.gated);
    const mls = fakeMls();
    vi.mocked(mls.changeDeviceKey).mockRejectedValueOnce(new Error('persist failed'));

    const failure = await performPinChange(options('u-mls-throw', mls), OLD, NEW).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(KeyChangeInterruptedError);
    expect((failure as InstanceType<typeof KeyChangeInterruptedError>).stage).toBe('mls');
  });

  it('a throw at the VAULT step moved no data: typed as such, so the session may run on', async () => {
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-vault-throw', s.gated);
    const mls = fakeMls();
    vault.retireUnlabelledDeviceKeyIfOwnedBy.mockRejectedValueOnce(new Error('storage refused'));

    const failure = await performPinChange(options('u-vault-throw', mls), OLD, NEW).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(KeyChangeInterruptedError);
    const typed = failure as InstanceType<typeof KeyChangeInterruptedError>;
    expect(typed.stage).toBe('vault');
    expect(typed.dataMoved).toBe(false);
    expect(mls.changeDeviceKey).not.toHaveBeenCalled();
    await everyRowUnder(s.raw, OLD);
  });

  it('a KEYSTORE refusal is typed, moves nothing, and the recovery from the state it left finishes the job', async () => {
    // iPhone 12 bench, 2026-10-15: the server had rotated the verifier (pin-change 201), then the
    // keystore refused the write (no device passcode, errSecAuthFailed) and the refusal escaped
    // untyped - "retry", against a server that now refused the old PIN. The state it left: server on
    // the new PIN, keystore holding no key, every store AND the MLS state under the old key.
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-keystore-throw', s.gated);
    const mls = fakeMls([], OLD);
    vi.mocked(mls.pointUnattendedUnlockAt).mockRejectedValueOnce(
      new Error('The operation could not be completed. (OSStatus error -25293.)')
    );
    vault.clearDeviceKey.mockClear();
    vault.saveDeviceKey.mockClear();
    const change = options('u-keystore-throw', mls);

    const failure = await performPinChange(change, OLD, NEW).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(KeyChangeInterruptedError);
    const typed = failure as InstanceType<typeof KeyChangeInterruptedError>;
    expect(typed.stage).toBe('keystore');
    expect(typed.dataMoved).toBe(false);
    expect(typed.keystoreMoved).toBe(false);
    // The vault's old key left BEFORE the keystore was asked: no unattended unlock stays on it.
    expect(vault.clearDeviceKey).toHaveBeenCalledWith('u-keystore-throw');
    expect(vault.retireUnlabelledDeviceKeyIfOwnedBy).toHaveBeenCalledWith('u-keystore-throw', OLD);
    expect(vault.saveDeviceKey).not.toHaveBeenCalled();
    expect(mls.changeDeviceKey).not.toHaveBeenCalled();
    expect(change.setDeviceKey).not.toHaveBeenCalled();
    await everyRowUnder(s.raw, OLD);

    // The recovery the next unlock is sent to (old PIN, new PIN), the keystore writing again.
    const recovery = options('u-keystore-throw', mls, new Uint8Array([1]));
    await performPinChange(recovery, OLD, NEW);

    await everyRowUnder(s.raw, NEW);
    expect(mls.changeDeviceKey).toHaveBeenCalledWith(NEW);
    expect(recovery.setDeviceKey).toHaveBeenCalledWith(NEW);
  });

  it('PIN1 -> PIN2 refused by the keystore, relaunch, recovery, then PIN2 -> PIN3: nothing stranded', async () => {
    // Before 2026-10-15 the vault was cleared AFTER the keystore, so a refusal left it on PIN1: a
    // device without biometrics logged in silently on PIN1 (no server check, no recovery), and the
    // next change derived its "old" key from PIN2 - rows under PIN1 opened under neither key, the
    // live MLS state moved to PIN3, and messages, seeds and outbox stayed under PIN1 for good.
    const { OLD: K1, NEW: K2 } = keys();
    const K3 = key();
    const userId = 'u-pin1-pin2-pin3';
    const s = await populated(K1);
    storageForUser.set(userId, s.gated);
    const slots = new Map<string, string>([[userId, K1]]);
    vault.clearDeviceKey.mockImplementation((u: string) => void slots.delete(u));
    vault.saveDeviceKey.mockImplementation(async (u: string, k: string) => void slots.set(u, k));
    let mlsKey = K1;
    const mls = {
      openLocalStateWithKey: vi.fn(async (_u: string, k: string) =>
        k === mlsKey ? { opened: true } : { opened: false, cause: 'undecryptable' }
      ),
      pointUnattendedUnlockAt: vi
        .fn()
        .mockRejectedValueOnce(new Error('errSecAuthFailed'))
        .mockResolvedValue(true),
      changeDeviceKey: vi.fn(async (k: string) => void (mlsKey = k)),
    } as unknown as IMlsService;

    try {
      const failure = await performPinChange(options(userId, mls), K1, K2).catch((e: unknown) => e);
      expect((failure as InstanceType<typeof KeyChangeInterruptedError>).stage).toBe('keystore');

      // Relaunch: no vault key to unlock with, so the PIN is asked; the server takes PIN2, whose key
      // does not open the MLS state - which is exactly what offers the recovery.
      expect(slots.get(userId)).toBeUndefined();
      expect(
        (await mls.openLocalStateWithKey(userId, K2, new Uint8Array([1]))).opened,
        'the MLS state must refuse the PIN2 key, or no recovery is offered'
      ).toBe(false);

      await performPinChange(options(userId, mls, new Uint8Array([1])), K1, K2);
      await everyRowUnder(s.raw, K2);
      expect(mlsKey).toBe(K2);
      expect(slots.get(userId)).toBe(K2);

      await performPinChange(options(userId, mls), K2, K3);
      await everyRowUnder(s.raw, K3);
      expect(mlsKey).toBe(K3);
    } finally {
      vault.clearDeviceKey.mockImplementation(() => {});
      vault.saveDeviceKey.mockResolvedValue(undefined);
    }
  });

  it("retires an older build's UNLABELLED vault slot holding the old key, before the new key is saved", async () => {
    // That slot unlocks without the server PIN check: kept past a kill, it opens the MLS state not
    // yet re-sealed and runs a session over stores already half moved.
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-unlabelled', s.gated);
    const order: string[] = [];
    vault.retireUnlabelledDeviceKeyIfOwnedBy.mockImplementationOnce(async () => {
      order.push('retire-unlabelled');
      return true;
    });
    vault.saveDeviceKey.mockImplementationOnce(async () => {
      order.push('vault-save');
    });

    await performPinChange(options('u-unlabelled', fakeMls()), OLD, NEW);

    expect(vault.retireUnlabelledDeviceKeyIfOwnedBy).toHaveBeenCalledWith('u-unlabelled', OLD);
    expect(order).toEqual(['retire-unlabelled', 'vault-save']);
  });

  it('a call ALREADY IN FLIGHT when the change starts finishes before the pass reads', async () => {
    // Started before the hold: it is inside the store, under the old key. Read before it lands, its
    // row would be missing from the pass and stay under the old key for good.
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-inflight', s.gated);
    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    const save = s.raw.saveMessage.bind(s.raw);
    vi.spyOn(s.raw, 'saveMessage').mockImplementationOnce(async (msg, k) => {
      await landed;
      return save(msg, k);
    });
    const inFlight = s.gated.saveMessage(message('m9'), OLD);
    await Promise.resolve();

    const change = performPinChange(options('u-inflight', fakeMls()), OLD, NEW);
    await flushMacrotask();
    land();
    await Promise.all([inFlight, change]);

    await everyRowUnder(s.raw, NEW);
    expect(await s.raw.getMessage('m9', NEW)).not.toBeNull();
  });

  it('a recovery whose MLS opens succeeds even with a row under an older key (no lockout)', async () => {
    const { OLD, NEW, WRONG: K0 } = keys();
    const s = await populated(OLD);
    await s.raw.saveGraineSession(session('stranded'), K0);
    storageForUser.set('u-k0', s.gated);
    const mls = fakeMls([], OLD);

    await performPinChange(options('u-k0', mls, new Uint8Array([1])), OLD, NEW);

    expect(mls.changeDeviceKey).toHaveBeenCalledWith(NEW);
    expect(await s.raw.getGraineSession('s1', NEW)).toEqual(session('s1'));
  });

  it('moves the unattended unlock FIRST and the MLS state LAST, the stores in between', async () => {
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-order', s.gated);
    const order: string[] = [];
    vault.clearDeviceKey.mockImplementation(() => order.push('vault-clear'));
    vault.saveDeviceKey.mockImplementation(async () => {
      order.push('vault-save');
    });
    const real = s.raw.swapSealedPayloads.bind(s.raw);
    vi.spyOn(s.raw, 'swapSealedPayloads').mockImplementation(async (store, swaps) => {
      order.push(store);
      return real(store, swaps);
    });

    await performPinChange(options('u-order', fakeMls(order)), OLD, NEW);

    expect(order).toEqual([
      'vault-clear',
      'keystore',
      'vault-save',
      'messages',
      'graine',
      'outbox',
      'mls-reseal',
    ]);
  });

  it('a failure in the stores never reaches the MLS state; the same two keys finish it', async () => {
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-kill', s.gated);
    vi.spyOn(s.raw, 'swapSealedPayloads').mockRejectedValueOnce(new Error('disk full'));
    const mls = fakeMls([], OLD);
    const opts = options('u-kill', mls);

    const failure = await performPinChange(opts, OLD, NEW).catch((e: unknown) => e);

    // TYPED, so the caller ends the session into the recovery instead of running on the old key.
    expect(failure).toBeInstanceOf(KeyChangeInterruptedError);
    expect((failure as InstanceType<typeof KeyChangeInterruptedError>).stage).toBe('stores');
    expect((failure as InstanceType<typeof KeyChangeInterruptedError>).dataMoved).toBe(true);
    expect(String((failure as Error).message)).toContain('disk full');
    expect(mls.changeDeviceKey).not.toHaveBeenCalled();
    expect(opts.setDeviceKey).not.toHaveBeenCalled();
    // The recovery the next launch is sent to: the MLS state still opens with the old key.
    await performPinChange(options('u-kill', mls, new Uint8Array([1])), OLD, NEW);
    await everyRowUnder(s.raw, NEW);
  });

  it('writes the LIVE session makes during the change are held, then land under the new key', async () => {
    // The race the gate deletes: an edit to m1, a new m3, a seed received and a message queued -
    // each issued by the session with the key it still holds (OLD) while the stores are moving.
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-live', s.gated);
    const live: Promise<unknown>[] = [];
    const read = s.raw.getSealedPayloads.bind(s.raw);
    vi.spyOn(s.raw, 'getSealedPayloads').mockImplementation(async (store) => {
      const rows = await read(store);
      if (store === 'messages') {
        live.push(
          s.gated.updateMessage('m1', { content: message('m1', 'edited').content }, OLD),
          s.gated.saveMessage(message('m3'), OLD),
          s.gated.saveGraineSession(session('s3'), OLD),
          s.gated.saveOutboxEntry(queued('o2'), OLD)
        );
      }
      return rows;
    });

    await performPinChange(options('u-live', fakeMls()), OLD, NEW);
    await Promise.all(live);

    await everyRowUnder(s.raw, NEW);
    expect((await s.raw.getMessage('m1', NEW))?.content).toBe(message('m1', 'edited').content);
    expect(await s.raw.getMessage('m3', NEW)).not.toBeNull();
    expect(await s.raw.getGraineSession('s3', NEW)).toEqual(session('s3'));
    expect((await s.raw.getOutboxEntry('o2', NEW))?.text).toBe('queued o2');
  });

  it('a caller still holding the retired key reads what the change moved', async () => {
    // The outbox flusher reading a re-sealed row with the old key would park it as undecryptable.
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-stale', s.gated);

    await performPinChange(options('u-stale', fakeMls()), OLD, NEW);

    expect((await s.gated.getOutboxEntry('o1', OLD))?.text).toBe('queued o1');
    expect(await s.gated.getGraineSession('s1', OLD)).toEqual(session('s1'));
  });

  it('a queued text, reaction and attachment each survive the change, the attachment blob untouched', async () => {
    // Read the way the flusher reads them (`getOutboxEntry`, with the key the session now holds).
    // The attachment's bytes live in the blob store, sealed by a key kept INSIDE the row: only the
    // row is re-sealed, so the blob must be neither rewritten nor lost.
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-outbox', s.gated);
    const reaction: OutboxEntry = {
      ...queued('r1'),
      kind: 'control',
      text: undefined,
      controlProto: new Uint8Array([8, 1, 18, 2, 0x3a, 0x29]),
    };
    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    const attachment: OutboxEntry = {
      ...queued('a1'),
      kind: 'media',
      text: undefined,
      media: { kind: 1, mimeType: 'image/png', size: bytes.length, fileBytes: bytes },
    };
    await s.raw.saveOutboxEntry(reaction, OLD);
    await s.raw.saveOutboxEntry(attachment, OLD);
    const blobs = (s.raw as unknown as { blobs: OutboxBlobStore }).blobs;
    const blobWrites = vi.spyOn(blobs, 'put');
    const blobDeletes = vi.spyOn(blobs, 'delete');

    await performPinChange(options('u-outbox', fakeMls()), OLD, NEW);

    expect(blobWrites).not.toHaveBeenCalled();
    expect(blobDeletes).not.toHaveBeenCalled();
    expect((await s.raw.getOutboxEntry('o1', NEW))?.text).toBe('queued o1');
    expect((await s.raw.getOutboxEntry('r1', NEW))?.controlProto).toEqual(reaction.controlProto);
    const media = (await s.raw.getOutboxEntry('a1', NEW))?.media;
    expect(media?.fileBytes).toEqual(bytes);
    await expect(s.raw.getOutboxEntry('a1', OLD)).rejects.toThrow();
  });

  it('a flush that reads the outbox AFTER its rows moved, before the key is retired, is held', async () => {
    // The window the gate closes: the outbox rows are already under NEW, the session (and so the
    // flusher) still holds OLD, and the retired key is not forwarded yet. A read let through here
    // parks the row as unreadable; the gate holds it until the change retires OLD, then forwards it.
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-flush', s.gated);
    let flush: Promise<OutboxEntry | null> | undefined;
    const swap = s.raw.swapSealedPayloads.bind(s.raw);
    vi.spyOn(s.raw, 'swapSealedPayloads').mockImplementation(async (store, swaps) => {
      const swapped = await swap(store, swaps);
      // Issued, never awaited here: awaiting it inside the pass would wait on the pass itself.
      if (store === 'outbox') flush = s.gated.getOutboxEntry('o1', OLD);
      return swapped;
    });

    await performPinChange(options('u-flush', fakeMls()), OLD, NEW);

    expect(flush).toBeDefined();
    expect((await flush!)?.text).toBe('queued o1');
  });
});

describe('moveSealedStoresOnly - an install with no MLS state to carry', () => {
  it('moves every store, finishing a half-moved one, and retires the old key from the vault', async () => {
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    // A run killed half way already moved one row: it counts as done, not damaged.
    await s.raw.saveMessages([message('m9')], NEW);
    storageForUser.set('u-stores-only', s.gated);
    vault.clearDeviceKey.mockClear();

    await moveSealedStoresOnly('u-stores-only', OLD, NEW, () => {});

    await everyRowUnder(s.raw, NEW);
    expect(vault.clearDeviceKey).toHaveBeenCalledWith('u-stores-only');
  });

  it('a failure in the stores is typed as data moved, so the caller restarts', async () => {
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-stores-only-kill', s.gated);
    vi.spyOn(s.raw, 'swapSealedPayloads').mockRejectedValueOnce(new Error('disk full'));

    const failure = await moveSealedStoresOnly('u-stores-only-kill', OLD, NEW, () => {}).catch(
      (e: unknown) => e
    );

    expect(failure).toBeInstanceOf(KeyChangeInterruptedError);
    expect((failure as InstanceType<typeof KeyChangeInterruptedError>).dataMoved).toBe(true);
    // The same two keys finish it.
    await moveSealedStoresOnly('u-stores-only-kill', OLD, NEW, () => {});
    await everyRowUnder(s.raw, NEW);
  });
});

describe('dropStoredFeedPages', () => {
  it('drops the feed copy rather than leaving it sealed under a key this device no longer has', async () => {
    const { raw } = await freshStorage();
    vi.spyOn(raw, 'deleteFeedPages').mockResolvedValue(3);
    const log = vi.fn();

    await dropStoredFeedPages(raw, log);

    expect(raw.deleteFeedPages).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('3 stored feed page(s) dropped'));
  });

  it('logs a refused delete and does not fail the PIN change', async () => {
    const { raw } = await freshStorage();
    vi.spyOn(raw, 'deleteFeedPages').mockRejectedValue(new Error('disk full'));
    const log = vi.fn();

    await expect(dropStoredFeedPages(raw, log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('a PIN change drops them, under the hold, on the store behind the gate', async () => {
    const { OLD, NEW } = keys();
    const s = await populated(OLD);
    storageForUser.set('u-feed', s.gated);
    const dropped = vi.spyOn(s.raw, 'deleteFeedPages');

    await performPinChange(options('u-feed', fakeMls()), OLD, NEW);

    expect(dropped).toHaveBeenCalledTimes(1);
  });
});
