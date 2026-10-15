/**
 * The seam every `IStorage` call crosses, so a device key change can HOLD the storage work of every
 * realm that writes the same database while it moves the stores, and FORWARD the retired key once it
 * has.
 *
 * WHY A GATE AND NOT A SECOND PASS. An in-session PIN change runs with the session live: the outbox
 * flusher, the message pipeline and the Graine runtime keep reading and writing while the stores are
 * re-sealed. Without this, a row written under the old key after the pass had read its table stayed
 * under the old key once the session adopted the new one - unreadable for good - and a flusher
 * reading an already re-sealed outbox row with the old key parked it as undecryptable. A sweep after
 * the fact would heal that race, and a race that heals is still a race; this deletes the overlap.
 *
 * TWO SCOPES, BECAUSE ONE DATABASE IS SHARED BY SEVERAL REALMS. On the web every tab of the account
 * opens the SAME IndexedDB; a follower tab writes outbox rows into it with the key IT holds in
 * memory, and nothing in its realm sees this realm's change.
 *
 *  - IN THIS REALM ({@link holdStorageForKeyChange}): every call in flight finishes, then the re-seal
 *    runs while every new call WAITS at the gate - no write lands between its read and its swap.
 *  - ACROSS REALMS ({@link holdOtherRealmsForKeyChange}): every realm holds the Web Lock
 *    `canari-device-key:<userId>` in SHARED mode while it may touch the store, and a call waits until
 *    it holds it. The changer queues the EXCLUSIVE mode FIRST (so a realm opening from then on queues
 *    behind it), then announces the change on {@link KEY_CHANGE_CHANNEL}. A realm that hears it goes
 *    STALE - every later call is refused with {@link StaleDeviceKeyError} - lets its calls in flight
 *    finish, releases its shared lock, and ends into the recovery ({@link setKeyRecoveryHandler}: a
 *    reload, which comes back with the vault's new key and waits for the lock behind the change).
 *    Only once every other realm has let go does the exclusive mode start, so no other realm writes
 *    while data moves, and none writes with the old key afterwards. No timer anywhere: a realm that
 *    has not answered yet holds the change, it is never presumed gone.
 *  - FORWARD: the key a caller passes is evaluated BEFORE it reaches the gate, so a call queued behind
 *    the change still carries the old key. Once the change commits, the gate maps the retired key to
 *    its successor on every argument, so that call - and any closure still holding the old value -
 *    reads and writes under the key the store is now actually under. This is a known fact (the change
 *    itself recorded it), never a guess made from a failed decrypt.
 *
 * NO `navigator.locks` (happy-dom; WebKitGTK) is ONE realm, the reading `tabLeader.ts` already makes
 * of the same absence: the in-realm hold is then the whole of it.
 *
 * The retired key stays in this process's memory for the life of the page, where it already was.
 * Methods are bound to the real store, so a store's own internal calls never re-enter the gate.
 */
import type { IStorage } from './types';

/** The channel a key change is announced on, to the other realms of this origin. */
export const KEY_CHANGE_CHANNEL = 'canari-device-key';

/** The Web Lock every realm holds SHARED while it may touch `userId`'s store. */
function lockName(userId: string): string {
  return `canari-device-key:${userId}`;
}

/** The notice a changer posts BEFORE any data moves. Carries the account, never a key. */
interface KeyChangeNotice {
  type: 'key_change_starting';
  userId: string;
}

/**
 * Thrown by every storage call of a realm whose device key a change in ANOTHER realm has retired.
 * Typed so a caller can tell "this tab is ending into the recovery" from a storage failure, and
 * refused rather than run: a write under the retired key would land after the re-seal and be lost.
 */
export class StaleDeviceKeyError extends Error {
  constructor() {
    super('another realm changed the device key: this realm no longer writes the store');
    this.name = 'StaleDeviceKeyError';
  }
}

/** Resolves when the running in-realm key change ends; `null` when none runs. */
let exclusive: Promise<void> | null = null;
/** Calls currently inside the store. */
let active = 0;
/** Wakes whoever waits for the calls in flight to drain. */
let drainWaiters: (() => void)[] = [];
/** Retired device key -> the key it was replaced by. Kept flat (no chains, no cycles). */
const successor = new Map<string, string>();
/** Gated handle -> the store behind it and its account, for the one caller that must not wait. */
const targets = new WeakMap<IStorage, { raw: IStorage; userId: string }>();

/** This realm's standing towards one account's cross-realm lock. */
interface RealmHold {
  /** True while this realm holds the shared lock (always, without Web Locks). */
  held: boolean;
  /** Resolves when the shared lock is next granted. */
  granted: Promise<void>;
  /** Lets go of the shared lock (a no-op when not held). */
  release: () => void;
  /** Another realm changed the key: every call is refused from now on. */
  stale: boolean;
  /**
   * THIS realm runs the change and holds (or waits for) the exclusive mode: its own calls do not
   * wait for the shared lock it let go - {@link holdStorageForKeyChange} holds them where it must,
   * and the MLS re-seal inside the change may itself wait on one of them.
   */
  changing: boolean;
}

const holds = new Map<string, RealmHold>();
let channel: BroadcastChannel | null = null;

/** Ends this realm into the recovery. A reload by default: it comes back with the vault's key. */
let recoveryHandler: (reason: string) => void = () => {
  globalThis.location?.reload();
};

/** Replaces how this realm ends into the recovery (tests; a shell with its own restart). */
export function setKeyRecoveryHandler(handler: ((reason: string) => void) | null): void {
  recoveryHandler =
    handler ??
    (() => {
      globalThis.location?.reload();
    });
}

/**
 * Ends this realm's session into the recovery: a realm whose key another realm retired, or a change
 * that threw after the unattended unlock had moved. Logged here, once, for both.
 */
export function endIntoKeyRecovery(reason: string): void {
  console.warn(`[DEVICEKEY] Ending this session into the PIN recovery: ${reason}`);
  recoveryHandler(reason);
}

function webLocks(): LockManager | null {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/** Requests the shared lock for `hold`, which it keeps until `hold.release()`. */
function requestShared(locks: LockManager, userId: string, hold: RealmHold): void {
  hold.held = false;
  let until!: () => void;
  const released = new Promise<void>((resolve) => {
    until = resolve;
  });
  hold.release = until;
  hold.granted = new Promise<void>((granted) => {
    locks
      .request(lockName(userId), { mode: 'shared' }, () => {
        hold.held = true;
        granted();
        return released;
      })
      .catch((e: unknown) => {
        // EVERY SWALLOWED BRANCH LOGS. A refused lock leaves `held` false, so the gate keeps every
        // call waiting rather than writing unheld.
        console.error(`[DEVICEKEY] The shared device-key lock was refused: ${String(e)}`);
      });
  });
}

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(KEY_CHANGE_CHANNEL);
  channel.addEventListener('message', (ev: MessageEvent<KeyChangeNotice>) => {
    if (ev.data?.type === 'key_change_starting') void onKeyChangeNotice(ev.data.userId);
  });
  return channel;
}

/** This realm's hold on `userId`'s lock, requested the first time one of its stores is gated. */
function realmHold(userId: string): RealmHold {
  let hold = holds.get(userId);
  if (hold) return hold;
  hold = {
    held: true,
    granted: Promise.resolve(),
    release: () => {},
    stale: false,
    changing: false,
  };
  holds.set(userId, hold);
  const locks = webLocks();
  if (locks) {
    // Listening BEFORE asking: a realm that holds the lock has always been able to hear the notice.
    ensureChannel();
    requestShared(locks, userId, hold);
  }
  return hold;
}

/** Another realm is about to move the stores: stop, drain, let go, end into the recovery. */
async function onKeyChangeNotice(userId: string): Promise<void> {
  const hold = holds.get(userId);
  if (!hold || hold.stale) return;
  hold.stale = true;
  console.warn('[DEVICEKEY] Another tab is changing the device key: this tab stops writing.');
  await drain();
  hold.release();
  endIntoKeyRecovery('another tab changed the device key');
}

function drain(): Promise<void> {
  if (active === 0) return Promise.resolve();
  return new Promise<void>((resolve) => drainWaiters.push(resolve));
}

async function enter(hold: RealmHold): Promise<void> {
  for (;;) {
    if (hold.stale) throw new StaleDeviceKeyError();
    if (exclusive) await exclusive;
    else if (!hold.held && !hold.changing) await hold.granted;
    else break;
  }
  active++;
}

function leave(): void {
  active--;
  if (active === 0 && drainWaiters.length > 0) {
    const wake = drainWaiters;
    drainWaiters = [];
    for (const w of wake) w();
  }
}

/** A string argument naming a retired key becomes the key that replaced it; anything else passes. */
function forward(arg: unknown): unknown {
  return typeof arg === 'string' ? (successor.get(arg) ?? arg) : arg;
}

/** Records `oldKey -> newKey`, keeping the map flat: a key that is current again maps to nothing. */
function retire(oldKey: string, newKey: string): void {
  successor.delete(newKey);
  for (const [k, v] of successor) if (v === oldKey) successor.set(k, newKey);
  successor.set(oldKey, newKey);
}

/**
 * Wraps `userId`'s store so every call goes through the gate, and takes this realm's shared hold on
 * that account's lock. Applied once, where stores are opened (`getStorage`), so no caller can reach a
 * store around it.
 */
export function gateStorage(storage: IStorage, userId: string): IStorage {
  const hold = realmHold(userId);
  const gated = new Proxy(storage, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        try {
          await enter(hold);
        } catch (e) {
          if (e instanceof StaleDeviceKeyError) {
            console.warn(`[DEVICEKEY] Refused ${String(prop)}: this tab's device key is retired.`);
          }
          throw e;
        }
        try {
          return await method.apply(target, args.map(forward));
        } finally {
          leave();
        }
      };
    },
  });
  targets.set(gated, { raw: storage, userId });
  return gated;
}

/**
 * Runs `work` - the whole store move of a key change, MLS state included - while no OTHER realm can
 * touch `userId`'s store, and after every one of them has been told its key is retired.
 *
 * The exclusive mode is QUEUED before the notice is posted, so a realm that opens after the notice
 * queues behind it rather than slipping in with a key it read before the vault moved. This realm's
 * own shared hold is released for the exclusive mode to start, and asked for again behind it. Its
 * own callers do not wait for that lock meanwhile ({@link RealmHold.changing}): the realm that holds
 * the exclusive mode is the one that may write, {@link holdStorageForKeyChange} holds them while the
 * stores move, and the MLS re-seal inside `work` must not wait on a call that waits on `work`.
 * Without Web Locks it is `work()`.
 */
export async function holdOtherRealmsForKeyChange<T>(
  userId: string,
  work: () => Promise<T>
): Promise<T> {
  const locks = webLocks();
  if (!locks) return work();
  const hold = realmHold(userId);
  hold.changing = true;
  const run = locks.request(lockName(userId), { mode: 'exclusive' }, () => work());
  const notice: KeyChangeNotice = { type: 'key_change_starting', userId };
  ensureChannel()?.postMessage(notice);
  console.log('[DEVICEKEY] Key change announced to the other tabs; waiting for them to let go.');
  // The shared hold is asked for again NOW, so it queues BEHIND the exclusive mode and is granted
  // the moment the change ends; only then is the current one let go, for the exclusive to start.
  const letGo = hold.release;
  requestShared(locks, userId, hold);
  letGo();
  try {
    return await run;
  } finally {
    hold.changing = false;
  }
}

/**
 * Runs `work` - the re-seal of every sealed store from `oldKey` to `newKey` - with the store to
 * itself IN THIS REALM: calls in flight finish first, new calls wait until it returns. On success the
 * old key is retired to the new one for every later call; on a throw nothing is retired, because the
 * stores are then still (partly) under the old key.
 *
 * `work` receives the store BEHIND the gate: going through the gated handle from inside would wait
 * for itself.
 */
export async function holdStorageForKeyChange<T>(
  storage: IStorage,
  oldKey: string,
  newKey: string,
  work: (store: IStorage) => Promise<T>
): Promise<T> {
  const target = targets.get(storage);
  // A store that was never gated has callers this cannot hold: refuse rather than re-seal under them.
  if (!target)
    throw new Error('holdStorageForKeyChange: the store was not opened through the gate');
  while (exclusive) await exclusive;
  let release!: () => void;
  exclusive = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await drain();
    const result = await work(target.raw);
    retire(oldKey, newKey);
    return result;
  } finally {
    exclusive = null;
    release();
  }
}
