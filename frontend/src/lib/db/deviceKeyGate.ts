/**
 * The seam every `IStorage` call AND every MLS state read or write crosses, so a device key change
 * can HOLD the work of every realm that touches the same databases while it moves them, and FORWARD
 * the retired key once it has.
 *
 * WHY A GATE AND NOT A SECOND PASS. An in-session PIN change runs with the session live: the outbox
 * flusher, the message pipeline and the Graine runtime keep reading and writing while the stores are
 * re-sealed. Without this, a row written under the old key after the pass had read its table stayed
 * under the old key once the session adopted the new one - unreadable for good - and a flusher
 * reading an already re-sealed outbox row with the old key parked it as undecryptable. A sweep after
 * the fact would heal that race, and a race that heals is still a race; this deletes the overlap.
 *
 * TWO SCOPES, BECAUSE ONE DATABASE IS SHARED BY SEVERAL REALMS. On the web every tab of the account
 * opens the SAME IndexedDB (stores and `CanariDBMls_<userId>`); a follower tab writes outbox rows
 * into it with the key IT holds in memory, a leader checkpoints its MLS state, a reloading tab reads
 * that state - and nothing in their realms sees this realm's change.
 *
 *  - IN THIS REALM ({@link holdStorageForKeyChange}): every call in flight finishes, then the re-seal
 *    runs while every new call WAITS at the gate - no write lands between its read and its swap.
 *  - ACROSS REALMS ({@link holdOtherRealmsForKeyChange}): every realm holds the Web Lock
 *    `canari-device-key:<userId>` in SHARED mode while it may touch the databases, and a call waits
 *    until it holds it - storage calls through {@link gateStorage}, the MLS state's reads and writes
 *    through {@link withDeviceKeyHeld}. The changer queues the EXCLUSIVE mode FIRST (so a realm
 *    opening from then on queues behind it), then announces the change on {@link KEY_CHANGE_CHANNEL}.
 *    A realm that hears it goes STALE - every later call is refused with {@link StaleDeviceKeyError}
 *    - lets its calls in flight finish, releases its shared lock, and ends into the recovery
 *    ({@link setKeyRecoveryHandler}: a reload, whose first MLS read waits behind the change and which
 *    comes back with the vault's new key onto a state already moved). No timer anywhere: a realm that
 *    has not answered holds the change - the changer is told, to say so ({@link KeyChangeWaiting}) -
 *    and is never presumed gone.
 *  - THE EPOCH: a counter in `localStorage` the changer bumps inside the exclusive mode. A realm reads
 *    it when it first joins the lock (before its key is read, {@link joinDeviceKeyLock}), and checks
 *    it every time the shared mode is granted again: a tab that was away (bfcache, frozen) while
 *    another changed the key finds a newer epoch and goes stale instead of writing with the old key.
 *    The same check, inside the exclusive mode, stops the SECOND of two concurrent changes before it
 *    touches the vault ({@link KeyChangeSupersededError}).
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
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/** The channel a key change is announced on, to the other realms of this origin. */
export const KEY_CHANGE_CHANNEL = 'canari-device-key';

/** The Web Lock every realm holds SHARED while it may touch `userId`'s databases. */
function lockName(userId: string): string {
  return `canari-device-key:${userId}`;
}

/** The `localStorage` counter of completed-or-started key changes for `userId`. */
function epochKey(userId: string): string {
  return ACCOUNT_KEY.deviceKeyEpoch(userId);
}

/** The notice a changer posts BEFORE any data moves. Carries the account, never a key. */
interface KeyChangeNotice {
  type: 'key_change_starting';
  userId: string;
}

/**
 * Thrown by every gated call of a realm whose device key another realm has retired. Typed so a
 * caller can tell "this tab is ending into the recovery" from a storage failure, and refused rather
 * than run: a write under the retired key would land after the re-seal and be lost.
 */
export class StaleDeviceKeyError extends Error {
  constructor() {
    super('another realm changed the device key: this realm no longer writes the store');
    this.name = 'StaleDeviceKeyError';
  }
}

/**
 * Thrown by {@link holdOtherRealmsForKeyChange} when, once it holds the exclusive mode, the epoch is
 * no longer the one this realm joined with: another tab changed the key first. Nothing of this change
 * has moved (the vault step runs inside the exclusive mode), and this realm's key is stale.
 */
export class KeyChangeSupersededError extends Error {
  constructor() {
    super('another realm changed the device key first: this change did not start');
    this.name = 'KeyChangeSupersededError';
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
  userId: string;
  /** True while this realm holds the shared lock (always, without Web Locks). */
  held: boolean;
  /** Resolves when the shared lock is next granted (or the realm goes stale). */
  granted: Promise<void>;
  /** Lets go of the shared lock (a no-op when not held). */
  release: () => void;
  /** Wakes the callers parked while the page was suspended, once it is asked for again. */
  wake: (() => void) | null;
  /** Another realm changed the key: every call is refused from now on. */
  stale: boolean;
  /**
   * THIS realm runs the change and holds (or waits for) the exclusive mode: its own calls do not
   * wait for the shared lock it let go - {@link holdStorageForKeyChange} holds them where it must,
   * and the MLS re-seal inside the change waits on the gate itself.
   */
  changing: boolean;
  /** The epoch this realm's key belongs to (`null` when `localStorage` cannot be read). */
  epoch: string | null;
  /** Another tab announced a change while this one was changing: let it through afterwards. */
  yieldAfterChange: boolean;
}

const holds = new Map<string, RealmHold>();
let channel: BroadcastChannel | null = null;
let lifecycleArmed = false;
/** A suspension deferred while a call was inside: run when the last one leaves. */
let releaseWhenIdle: (() => void) | null = null;

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

/**
 * The stored epoch: a counter, `'0'` when no change ever ran here, or `null` when it cannot be read.
 * Only the join reads it raw; every comparison goes through {@link epochMoved}.
 */
function readEpoch(userId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(epochKey(userId)) ?? '0';
  } catch (e) {
    // EVERY SWALLOWED BRANCH LOGS. Without the epoch the lock and the notice still hold every tab
    // that is awake; only a tab that was away cannot be told.
    console.error(`[DEVICEKEY] The key-change epoch cannot be read: ${String(e)}`);
    return null;
  }
}

/**
 * Whether a change this realm did not make has moved the epoch since it joined.
 *
 * AN ABSENT COUNTER IS NOT A CHANGE. A change always writes a counter of 1 or more, so a key that is
 * GONE while this realm joined with a number means `localStorage` was cleared under an IndexedDB
 * that stayed - read as `'0'`, it reloaded an open tab for nothing and refused the next change as
 * superseded. It is logged, and the counter this realm knows is written back.
 */
function epochMoved(hold: RealmHold): boolean {
  let stored: string | null;
  try {
    stored = globalThis.localStorage?.getItem(epochKey(hold.userId)) ?? null;
  } catch (e) {
    console.error(`[DEVICEKEY] The key-change epoch cannot be read: ${String(e)}`);
    return false;
  }
  if (stored === null && hold.epoch !== null && hold.epoch !== '0') {
    console.warn(
      `[DEVICEKEY] The key-change epoch is gone (site storage cleared?) - not a change; restored.`
    );
    try {
      globalThis.localStorage?.setItem(epochKey(hold.userId), hold.epoch);
    } catch (e) {
      console.error(`[DEVICEKEY] The key-change epoch cannot be restored: ${String(e)}`);
    }
    return false;
  }
  return (stored ?? '0') !== (hold.epoch ?? '0');
}

function bumpEpoch(userId: string, from: string | null): string | null {
  const next = String((Number(from) || 0) + 1);
  try {
    globalThis.localStorage?.setItem(epochKey(userId), next);
    return next;
  } catch (e) {
    console.error(`[DEVICEKEY] The key-change epoch cannot be written: ${String(e)}`);
    return from;
  }
}

/**
 * Marks this realm stale - ONCE, and logged once: every later call is refused without a line of its
 * own - then lets its calls in flight finish, lets go of the lock and ends into the recovery.
 */
async function goStale(hold: RealmHold, reason: string): Promise<void> {
  if (hold.stale) return;
  hold.stale = true;
  console.warn(`[DEVICEKEY] ${reason}: this tab stops writing; every further call is refused.`);
  hold.wake?.();
  await drain();
  hold.release();
  endIntoKeyRecovery(reason);
}

/** Requests the shared lock for `hold`, which it keeps until `hold.release()`. */
function requestShared(locks: LockManager, hold: RealmHold): void {
  hold.held = false;
  let until!: () => void;
  const released = new Promise<void>((resolve) => {
    until = resolve;
  });
  hold.release = until;
  hold.granted = new Promise<void>((granted) => {
    locks
      .request(lockName(hold.userId), { mode: 'shared' }, () => {
        // A grant after a change this realm did not make (it was away, or joined before it) finds a
        // newer epoch: its key is the retired one.
        if (!hold.changing && epochMoved(hold)) {
          granted();
          void goStale(hold, 'The device key changed while this tab was away');
          return released;
        }
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
  // Callers parked on a suspended page's promise move onto this one.
  const wake = hold.wake;
  hold.wake = null;
  wake?.();
}

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(KEY_CHANGE_CHANNEL);
  channel.addEventListener('message', (ev: MessageEvent<KeyChangeNotice>) => {
    if (ev.data?.type === 'key_change_starting') onKeyChangeNotice(ev.data.userId);
  });
  return channel;
}

/**
 * A SUSPENDED PAGE MUST NOT HOLD THE LOCK. A page put in the back-forward cache, or frozen, runs no
 * code and so cannot hear a notice: holding the lock, it would hold every change for as long as it
 * sleeps. It lets go when it is put away and asks again when it comes back - and the epoch check on
 * that grant is what tells it whether its key was retired meanwhile. A page that is suspended WITHOUT
 * either event (iOS Safari in the background) keeps its lock, and the changer says so on screen.
 */
function armLifecycle(): void {
  if (lifecycleArmed || typeof document === 'undefined') return;
  lifecycleArmed = true;
  const suspend = () => {
    // NOT WHILE A CALL IS INSIDE. A call between its read and its write, suspended there, would
    // resume AFTER another tab re-sealed and write its row under the OLD key before any epoch check
    // could stop it - lost for good. So the lock is kept until the last call leaves (`leave`), and a
    // change waits for it meanwhile (and says so).
    if (active > 0) {
      console.log(
        '[DEVICEKEY] Page suspended with a call in flight: the lock is kept until it ends.'
      );
      releaseWhenIdle = suspendNow;
      return;
    }
    suspendNow();
  };
  const suspendNow = () => {
    for (const hold of holds.values()) {
      if (hold.stale || hold.changing || !hold.held) continue;
      hold.release();
      hold.held = false;
      hold.granted = new Promise<void>((resolve) => (hold.wake = resolve));
    }
  };
  const resume = () => {
    // Back before the last call left: the lock was never let go, and need not be.
    releaseWhenIdle = null;
    const locks = webLocks();
    if (!locks) return;
    for (const hold of holds.values()) {
      if (hold.stale || hold.held || !hold.wake) continue;
      requestShared(locks, hold);
    }
  };
  document.addEventListener('freeze', suspend);
  document.addEventListener('resume', resume);
  globalThis.addEventListener?.('pagehide', (ev) => {
    if ((ev as PageTransitionEvent).persisted) suspend();
  });
  globalThis.addEventListener?.('pageshow', (ev) => {
    if ((ev as PageTransitionEvent).persisted) resume();
  });
}

/**
 * Joins `userId`'s cross-realm lock: records the epoch the key about to be read belongs to and asks
 * for the shared mode. Called by the login BEFORE it reads a key, and implicitly by every gated call.
 */
export function joinDeviceKeyLock(userId: string): void {
  realmHold(userId);
}

function realmHold(userId: string): RealmHold {
  let hold = holds.get(userId);
  if (hold) return hold;
  hold = {
    userId,
    held: true,
    granted: Promise.resolve(),
    release: () => {},
    wake: null,
    stale: false,
    changing: false,
    epoch: null,
    yieldAfterChange: false,
  };
  holds.set(userId, hold);
  const locks = webLocks();
  if (locks) {
    hold.epoch = readEpoch(userId);
    // Listening BEFORE asking: a realm that holds the lock has always been able to hear the notice.
    ensureChannel();
    armLifecycle();
    requestShared(locks, hold);
  }
  return hold;
}

/** Another realm is about to move the stores: stop, drain, let go, end into the recovery. */
function onKeyChangeNotice(userId: string): void {
  const hold = holds.get(userId);
  if (!hold || hold.stale) return;
  if (hold.changing) {
    // TWO CHANGES AT ONCE. Reloading here would abandon a change half made, so this realm finishes
    // its own; the exclusive mode orders the two, and the later one stops on the epoch
    // (`KeyChangeSupersededError`). What the notice still asks is to let the other change through
    // once this one is done - see `holdOtherRealmsForKeyChange`.
    console.warn(
      '[DEVICEKEY] Another tab announced a key change while this one is changing: this change ' +
        'finishes first, then lets the other through.'
    );
    hold.yieldAfterChange = true;
    return;
  }
  void goStale(hold, 'Another tab is changing the device key');
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
  if (active === 0 && releaseWhenIdle) {
    const release = releaseWhenIdle;
    releaseWhenIdle = null;
    release();
  }
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

/**
 * The key `deviceKeyB64` is now, after every change this realm completed: itself, or the key that
 * retired it. Read INSIDE the gate ({@link withDeviceKeyHeld}) it is the key the stores are under -
 * the session adopts a new key only after the gate is released, so the session's copy can lag it.
 */
export function liveDeviceKey(deviceKeyB64: string): string {
  return successor.get(deviceKeyB64) ?? deviceKeyB64;
}

/** Records `oldKey -> newKey`, keeping the map flat: a key that is current again maps to nothing. */
function retire(oldKey: string, newKey: string): void {
  successor.delete(newKey);
  for (const [k, v] of successor) if (v === oldKey) successor.set(k, newKey);
  successor.set(oldKey, newKey);
}

/**
 * Runs `fn` - a read or a write of `userId`'s MLS state - through the gate: it waits for a change in
 * this realm and for the shared mode, and is refused once this realm is stale. So a tab reloading
 * after a notice reads the state only once it has MOVED, and an old leader's checkpoint cannot land
 * under the retired key after the change re-sealed it.
 */
export async function withDeviceKeyHeld<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await enter(realmHold(userId));
  try {
    return await fn();
  } finally {
    leave();
  }
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
        // A refusal (`StaleDeviceKeyError`) was logged once, when this realm went stale.
        await enter(hold);
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

/** Tells the changer the other tabs have not let go yet - so the screen can say why it waits. */
export type KeyChangeWaiting = () => void;

/**
 * Runs `work` - the whole move of a key change, vault, stores and MLS state - while no OTHER realm
 * can touch `userId`'s databases, after every one of them has been told its key is retired.
 *
 * The exclusive mode is QUEUED before the notice is posted, so a realm that opens after the notice
 * queues behind it rather than slipping in with a key it read before the vault moved. This realm's
 * own shared hold is released for the exclusive mode to start, and asked for again behind it. Its
 * own callers do not wait for that lock meanwhile ({@link RealmHold.changing}): the realm that holds
 * the exclusive mode is the one that may write, {@link holdStorageForKeyChange} holds them while the
 * stores move, and the MLS re-seal inside `work` goes through the gate itself.
 *
 * `onWaiting` is called when another tab still holds the lock, so the screen can say "another tab is
 * open" instead of sitting still. Without Web Locks it is `work()`.
 *
 * @throws {KeyChangeSupersededError} when another tab changed the key first; `work` never ran.
 */
export async function holdOtherRealmsForKeyChange<T>(
  userId: string,
  work: () => Promise<T>,
  onWaiting?: KeyChangeWaiting
): Promise<T> {
  const locks = webLocks();
  if (!locks) return work();
  const hold = realmHold(userId);
  hold.changing = true;
  try {
    const run = locks.request(lockName(userId), { mode: 'exclusive' }, async () => {
      if (epochMoved(hold)) {
        hold.stale = true;
        console.warn('[DEVICEKEY] Another tab changed the device key first: this change stops.');
        throw new KeyChangeSupersededError();
      }
      hold.epoch = bumpEpoch(userId, hold.epoch);
      return work();
    });
    const notice: KeyChangeNotice = { type: 'key_change_starting', userId };
    ensureChannel()?.postMessage(notice);
    if (onWaiting && (await otherHolders(locks, userId)) > 0) {
      console.log('[DEVICEKEY] Key change announced; another tab still holds the lock.');
      onWaiting();
    }
    // The shared hold is asked for again NOW, so it queues BEHIND the exclusive mode and is granted
    // the moment the change ends; only then is the current one let go, for the exclusive to start.
    const letGo = hold.release;
    requestShared(locks, hold);
    letGo();
    try {
      return await run;
    } finally {
      if (hold.yieldAfterChange) {
        // The other change queued its exclusive mode BEHIND this realm's shared re-request; holding
        // that for the page's life would hold the other change for ever. Let go once, and ask again
        // behind it - it stops on the epoch, and this realm's own epoch is the current one.
        hold.yieldAfterChange = false;
        await hold.granted;
        const again = hold.release;
        requestShared(locks, hold);
        again();
      }
    }
  } finally {
    hold.changing = false;
  }
}

/** How many OTHER holders of the shared mode there are (this realm's own counted out). */
async function otherHolders(locks: LockManager, userId: string): Promise<number> {
  if (typeof locks.query !== 'function') return 0;
  try {
    const snapshot = await locks.query();
    const shared = (snapshot.held ?? []).filter(
      (l) => l.name === lockName(userId) && l.mode === 'shared'
    ).length;
    return Math.max(0, shared - 1);
  } catch (e) {
    console.error(`[DEVICEKEY] The lock state cannot be queried: ${String(e)}`);
    return 0;
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
