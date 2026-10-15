/**
 * The storage gate across REALMS: two tabs of one account open the SAME IndexedDB, each with its own
 * copy of the gate module (its own in-realm hold, its own key in memory). The in-realm hold cannot
 * see the other tab; the Web Lock and the notice are what must stop it.
 *
 * Each realm is a fresh import of the gate (`vi.resetModules`), sharing one Web Locks manager and
 * one broadcast bus - the two things a browser shares between the tabs of an origin. Both doubles
 * follow the specification on the points that matter here: a lock queue is FIFO per name, shared
 * holders coexist, and a channel never delivers to the object that posted.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from '$lib/db/indexeddb';
import { decryptData } from '$lib/encryption';
import { toBase64 } from '$lib/utils/hex';
import type { StoredMessage } from '$lib/db';
import { resealDeviceKeyStores } from '$lib/utils/chat/pinChange';

type Gate = typeof import('./deviceKeyGate');

interface Pending {
  name: string;
  mode: LockMode;
  run: () => void;
}

/** A Web Locks manager: FIFO per name, shared holders coexist, exclusive excludes everything. */
class FakeLocks {
  private queue: Pending[] = [];
  private held: { name: string; mode: LockMode }[] = [];

  request(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<unknown>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const mode = options.mode ?? 'exclusive';
      const entry = { name, mode };
      this.queue.push({
        name,
        mode,
        run: () => {
          this.held.push(entry);
          Promise.resolve()
            .then(() => callback({ name, mode } as Lock))
            .then(resolve, reject)
            .finally(() => {
              this.held.splice(this.held.indexOf(entry), 1);
              this.pump();
            });
        },
      });
      this.pump();
    });
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length;) {
      const r = this.queue[i]!;
      const blockedAhead = this.queue.slice(0, i).some((q) => q.name === r.name);
      const conflict = this.held.some(
        (h) => h.name === r.name && (h.mode === 'exclusive' || r.mode === 'exclusive')
      );
      if (blockedAhead || conflict) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      r.run();
    }
  }
}

/** A BroadcastChannel bus: delivers to every OTHER channel of the same name, asynchronously. */
class FakeChannel {
  static open: FakeChannel[] = [];
  private listeners: ((ev: MessageEvent) => void)[] = [];
  constructor(readonly name: string) {
    FakeChannel.open.push(this);
  }
  addEventListener(_type: 'message', fn: (ev: MessageEvent) => void): void {
    this.listeners.push(fn);
  }
  postMessage(data: unknown): void {
    for (const ch of FakeChannel.open) {
      if (ch === this || ch.name !== this.name) continue;
      setTimeout(() => ch.listeners.forEach((fn) => fn({ data } as MessageEvent)), 0);
    }
  }
}

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
    const change = changer.holdOtherRealmsForKeyChange(userId, () =>
      changer.holdStorageForKeyChange(a, OLD, NEW, (store) => {
        passStarted = true;
        return resealDeviceKeyStores(store, OLD, NEW);
      })
    );
    // The notice reaches the follower; it may not hand the store over while its write is inside.
    await new Promise((r) => setTimeout(r, 10));
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
    expect(ended).toEqual(['another tab changed the device key']);
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
    await new Promise((r) => setTimeout(r, 10));
    expect(wrote).toBe(false);

    finish();
    await change;
    await write;
    expect(await opensUnder(rawA, NEW)).toEqual([true, true]);
  });
});
