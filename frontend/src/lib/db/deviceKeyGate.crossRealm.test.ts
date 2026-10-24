// @vitest-environment happy-dom
/**
 * The storage gate across REALMS: two tabs of one account open the SAME IndexedDB, each with its own
 * copy of the gate module (its own in-realm hold, its own key in memory). The in-realm hold cannot
 * see the other tab; the Web Lock and the notice are what must stop it.
 *
 * Each realm is a fresh import of the gate (`vi.resetModules`), sharing one Web Locks manager and
 * one broadcast bus - the two things a browser shares between the tabs of an origin
 * (`src/test/crossRealmDoubles.ts`).
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import { decryptData } from '$lib/encryption';
import { toBase64 } from '$lib/utils/hex';
import type { StoredMessage } from '$lib/db';
import { resealDeviceKeyStores } from '$lib/utils/chat/pinChange';
import { FakeChannel, FakeLocks } from '../../test/crossRealmDoubles';
import { flushMacrotask, settleUntilStable } from '../../test/flush';

type Gate = typeof import('./deviceKeyGate');

function key(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
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

async function realm(): Promise<Gate> {
  vi.resetModules();
  return import('./deviceKeyGate');
}

async function opensUnder(raw: IndexedDbStorage, k: string): Promise<boolean[]> {
  const rows = await raw.getSealedPayloads('messages');
  return Promise.all(
    rows.map((r) =>
      decryptData(r.cipherText, r.iv, k).then(
        () => true,
        () => false
      )
    )
  );
}

let counter = 0;

beforeEach(() => {
  FakeChannel.open = [];
  Object.defineProperty(navigator, 'locks', { value: new FakeLocks(), configurable: true });
  vi.stubGlobal('BroadcastChannel', FakeChannel);
});

afterEach(() => {
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  vi.unstubAllGlobals();
});

describe('deviceKeyGate across two tabs of one account', () => {
  it('the other tab stops BEFORE data moves, its in-flight write is moved, its late write refused', async () => {
    const OLD = key();
    const NEW = key();
    const userId = `cross-realm-${counter++}`;
    // Two handles on ONE database, as two tabs have.
    const rawA = new IndexedDbStorage(userId);
    await rawA.init();
    const rawB = new IndexedDbStorage(userId);
    await rawB.init();
    await rawA.saveMessages([message('m0'), message('m1')], OLD);

    const changer = await realm();
    const follower = await realm();
    const ended: string[] = [];
    follower.setKeyRecoveryHandler((reason) => ended.push(reason));
    const a = changer.gateStorage(rawA, userId);
    const b = follower.gateStorage(rawB, userId);
    // Both realms hold the shared lock before anything else happens.
    await a.getMessages('conv-1', OLD);
    await b.getMessages('conv-1', OLD);

    // The follower is inside the store with a write under the OLD key when the change starts.
    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    const save = rawB.saveMessage.bind(rawB);
    vi.spyOn(rawB, 'saveMessage').mockImplementationOnce(async (msg, k) => {
      await landed;
      return save(msg, k);
    });
    const inFlight = b.saveMessage(message('m2'), OLD);

    let passStarted = false;
    const waiting = vi.fn();
    const change = changer.holdOtherRealmsForKeyChange(
      userId,
      () =>
        changer.holdStorageForKeyChange(a, OLD, NEW, (store) => {
          passStarted = true;
          return resealDeviceKeyStores(store, OLD, NEW);
        }),
      waiting
    );
    // The notice reaches the follower; it may not hand the store over while its write is inside.
    // The screen is told why it waits: another tab still holds the lock.
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledTimes(1));
    expect(passStarted).toBe(false);
    // A write the follower issues now is REFUSED, not queued under a key about to be retired.
    await expect(b.saveMessage(message('m3'), OLD)).rejects.toBeInstanceOf(
      follower.StaleDeviceKeyError
    );

    land();
    await inFlight;
    const report = await change;

    expect(report.resealed.messages).toBe(3);
    expect(await opensUnder(rawA, NEW)).toEqual([true, true, true]);
    expect(ended).toEqual(['Another tab is changing the device key']);
    // A tab that wakes with the old key still refuses: it writes nothing until it has reloaded.
    await expect(b.saveMessage(message('m4'), OLD)).rejects.toBeInstanceOf(
      follower.StaleDeviceKeyError
    );
    expect(await opensUnder(rawA, NEW)).toEqual([true, true, true]);
    // The changer's own tab goes on writing, the retired key forwarded.
    await a.saveMessage(message('m5'), OLD);
    expect(await opensUnder(rawA, NEW)).toEqual([true, true, true, true]);
  });

  it('a tab that opens DURING the change waits behind it rather than writing with what it read', async () => {
    const OLD = key();
    const NEW = key();
    const userId = `cross-realm-${counter++}`;
    const rawA = new IndexedDbStorage(userId);
    await rawA.init();
    await rawA.saveMessages([message('m0')], OLD);
    const changer = await realm();
    const a = changer.gateStorage(rawA, userId);
    await a.getMessages('conv-1', OLD);

    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const change = changer.holdOtherRealmsForKeyChange(userId, async () => {
      await changer.holdStorageForKeyChange(a, OLD, NEW, (store) =>
        resealDeviceKeyStores(store, OLD, NEW)
      );
      await finished;
    });

    // A reloaded (or new) tab: it read the vault's key and opens the store mid-change.
    const late = await realm();
    late.setKeyRecoveryHandler(() => {});
    const rawC = new IndexedDbStorage(userId);
    await rawC.init();
    const c = late.gateStorage(rawC, userId);
    let wrote = false;
    const write = c.saveMessage(message('m1'), NEW).then(() => (wrote = true));
    await settleUntilStable(() => wrote);
    expect(wrote).toBe(false);

    finish();
    await change;
    await write;
    expect(await opensUnder(rawA, NEW)).toEqual([true, true]);
  });

  it("a reloading tab's MLS state read waits until the change has moved it", async () => {
    // The tab that hears the notice reloads at once; its boot reads the MLS state with the vault's
    // NEW key. Read before step 5, that state is still under the OLD key: a "rotated" recovery.
    const userId = `cross-realm-${counter++}`;
    const changer = await realm();
    changer.joinDeviceKeyLock(userId);
    await changer.withDeviceKeyHeld(userId, async () => {});
    const order: string[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const change = changer.holdOtherRealmsForKeyChange(userId, async () => {
      await finished;
      order.push('mls-resealed');
    });

    const reloaded = await realm();
    const read = reloaded.withDeviceKeyHeld(userId, async () => {
      order.push('mls-read');
    });
    await settleUntilStable(() => order.length);
    expect(order).toEqual([]);

    finish();
    await Promise.all([change, read]);
    expect(order).toEqual(['mls-resealed', 'mls-read']);
  });

  it("a stale tab's MLS checkpoint is REFUSED, never written under the retired key", async () => {
    // The old leader's unawaited checkpoint (Argon2, seconds) reaching the write after the notice.
    const userId = `cross-realm-${counter++}`;
    const changer = await realm();
    const leader = await realm();
    const ended: string[] = [];
    leader.setKeyRecoveryHandler((reason) => ended.push(reason));
    changer.joinDeviceKeyLock(userId);
    leader.joinDeviceKeyLock(userId);
    await changer.withDeviceKeyHeld(userId, async () => {});
    await leader.withDeviceKeyHeld(userId, async () => {});

    const wrote = vi.fn(async () => {});
    await changer.holdOtherRealmsForKeyChange(userId, async () => {});

    await expect(leader.withDeviceKeyHeld(userId, wrote)).rejects.toBeInstanceOf(
      leader.StaleDeviceKeyError
    );
    expect(wrote).not.toHaveBeenCalled();
    expect(ended).toHaveLength(1);
  });

  it("the changer's own calls inside the change do not wait for the lock it let go", async () => {
    // The MLS re-seal of step 5 writes through the gate. Waiting for the shared mode there would wait
    // for the exclusive mode, held by the very change waiting on it - a deadlock.
    const OLD = key();
    const userId = `cross-realm-${counter++}`;
    const raw = new IndexedDbStorage(userId);
    await raw.init();
    const changer = await realm();
    const a = changer.gateStorage(raw, userId);
    await a.getMessages('conv-1', OLD);

    const inside = await changer.holdOtherRealmsForKeyChange(userId, async () => {
      await changer.withDeviceKeyHeld(userId, async () => {});
      return a.getMessages('conv-1', OLD);
    });

    expect(inside).toEqual([]);
  }, 5_000);

  it('two changes from two tabs: the second stops before its vault step, neither reloads mid-change', async () => {
    const userId = `cross-realm-${counter++}`;
    const first = await realm();
    const second = await realm();
    const reloads: string[] = [];
    first.setKeyRecoveryHandler((r) => reloads.push(`first: ${r}`));
    second.setKeyRecoveryHandler((r) => reloads.push(`second: ${r}`));
    first.joinDeviceKeyLock(userId);
    second.joinDeviceKeyLock(userId);
    await first.withDeviceKeyHeld(userId, async () => {});
    await second.withDeviceKeyHeld(userId, async () => {});

    const ran: string[] = [];
    const one = first.holdOtherRealmsForKeyChange(userId, async () => {
      // Long enough for the second tab's notice to arrive while this one is changing.
      await flushMacrotask();
      await flushMacrotask();
      ran.push('first');
    });
    const two = second.holdOtherRealmsForKeyChange(userId, async () => {
      ran.push('second');
    });

    await one;
    await expect(two).rejects.toBeInstanceOf(second.KeyChangeSupersededError);
    expect(ran).toEqual(['first']);
    expect(reloads).toEqual([]);
  });

  it('a page put in the back-forward cache lets go, and finds the key retired when it comes back', async () => {
    const OLD = key();
    const userId = `cross-realm-${counter++}`;
    const rawA = new IndexedDbStorage(userId);
    await rawA.init();
    const rawB = new IndexedDbStorage(userId);
    await rawB.init();
    const changer = await realm();
    const a = changer.gateStorage(rawA, userId);
    await a.getMessages('conv-1', OLD);
    const sleeper = await realm();
    const ended: string[] = [];
    sleeper.setKeyRecoveryHandler((r) => ended.push(r));
    const b = sleeper.gateStorage(rawB, userId);
    await b.getMessages('conv-1', OLD);
    // Suspended: it runs no code, so it never hears the notice.
    FakeChannel.open.at(-1)!.deaf = true;

    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    // Held by a page that sleeps, this change would wait for ever.
    await changer.holdOtherRealmsForKeyChange(userId, async () => {});

    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await expect(b.saveMessage(message('m9'), OLD)).rejects.toBeInstanceOf(
      sleeper.StaleDeviceKeyError
    );
    expect(ended).toEqual(['The device key changed while this tab was away']);
    expect(await rawB.getMessage('m9', OLD)).toBeNull();
  });

  it('a page suspended with a call INSIDE keeps the lock until that call has written', async () => {
    // Suspended between its read and its write, then resumed after another tab re-sealed: the write
    // would land under the OLD key before any epoch check, and be lost for good.
    const OLD = key();
    const NEW = key();
    const userId = `cross-realm-${counter++}`;
    const rawA = new IndexedDbStorage(userId);
    await rawA.init();
    const rawB = new IndexedDbStorage(userId);
    await rawB.init();
    await rawA.saveMessages([message('m0')], OLD);
    const changer = await realm();
    const a = changer.gateStorage(rawA, userId);
    await a.getMessages('conv-1', OLD);
    const sleeper = await realm();
    sleeper.setKeyRecoveryHandler(() => {});
    const b = sleeper.gateStorage(rawB, userId);
    await b.getMessages('conv-1', OLD);
    FakeChannel.open.at(-1)!.deaf = true;

    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    const save = rawB.saveMessage.bind(rawB);
    vi.spyOn(rawB, 'saveMessage').mockImplementationOnce(async (msg, k) => {
      await landed;
      return save(msg, k);
    });
    const inside = b.saveMessage(message('m1'), OLD);
    await Promise.resolve();
    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));

    let done = false;
    const change = changer
      .holdOtherRealmsForKeyChange(userId, () =>
        changer.holdStorageForKeyChange(a, OLD, NEW, (store) =>
          resealDeviceKeyStores(store, OLD, NEW)
        )
      )
      .then(() => (done = true));
    await settleUntilStable(() => done);
    expect(done).toBe(false);

    land();
    await inside;
    await change;
    expect(await opensUnder(rawA, NEW)).toEqual([true, true]);
  });

  it('an epoch CLEARED with the site storage is not a change: no reload, the next change runs', async () => {
    const userId = `cross-realm-${counter++}`;
    const first = await realm();
    first.joinDeviceKeyLock(userId);
    await first.withDeviceKeyHeld(userId, async () => {});
    await first.holdOtherRealmsForKeyChange(userId, async () => {});
    const ended: string[] = [];
    first.setKeyRecoveryHandler((r) => ended.push(r));
    await first.withDeviceKeyHeld(userId, async () => {});

    localStorage.removeItem(`canari-device-key-epoch:${userId}`);
    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await first.withDeviceKeyHeld(userId, async () => {});
    const ran = vi.fn(async () => {});
    await first.holdOtherRealmsForKeyChange(userId, ran);

    expect(ended).toEqual([]);
    expect(ran).toHaveBeenCalledTimes(1);
  });
});
