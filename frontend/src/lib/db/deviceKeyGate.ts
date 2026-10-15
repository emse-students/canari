/**
 * The seam every `IStorage` call crosses, so a device key change can HOLD the session's storage
 * work while it moves the stores, and FORWARD the retired key once it has.
 *
 * WHY A GATE AND NOT A SECOND PASS. An in-session PIN change runs with the session live: the outbox
 * flusher, the message pipeline and the Graine runtime keep reading and writing while the stores are
 * re-sealed. Without this, a row written under the old key after the pass had read its table stayed
 * under the old key once the session adopted the new one - unreadable for good - and a flusher
 * reading an already re-sealed outbox row with the old key parked it as undecryptable. A sweep after
 * the fact would heal that race, and a race that heals is still a race; this deletes the overlap.
 *
 *  - HOLD: {@link holdStorageForKeyChange} waits for every call in flight to finish, then runs the
 *    re-seal while every new call WAITS at the gate - so no write lands between its read and its swap.
 *  - FORWARD: the key a caller passes is evaluated BEFORE it reaches the gate, so a call queued behind
 *    the change still carries the old key. Once the change commits, the gate maps the retired key to
 *    its successor on every argument, so that call - and any closure still holding the old value -
 *    reads and writes under the key the store is now actually under. This is a known fact (the change
 *    itself recorded it), never a guess made from a failed decrypt.
 *
 * The retired key stays in this process's memory for the life of the page, where it already was.
 * Methods are bound to the real store, so a store's own internal calls never re-enter the gate.
 */
import type { IStorage } from './types';

/** Resolves when the running key change ends; `null` when none runs. */
let exclusive: Promise<void> | null = null;
/** Calls currently inside the store. */
let active = 0;
/** Wakes the key change waiting for the calls in flight to drain. */
let drained: (() => void) | null = null;
/** Retired device key -> the key it was replaced by. Kept flat (no chains, no cycles). */
const successor = new Map<string, string>();
/** Gated handle -> the store behind it, for the one caller that must not wait at its own gate. */
const targets = new WeakMap<IStorage, IStorage>();

async function enter(): Promise<void> {
  while (exclusive) await exclusive;
  active++;
}

function leave(): void {
  active--;
  if (active === 0 && drained) {
    const wake = drained;
    drained = null;
    wake();
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
 * Wraps a store so every call goes through the gate. Applied once, where stores are opened
 * (`getStorage`), so no caller can reach a store around it.
 */
export function gateStorage(storage: IStorage): IStorage {
  const gated = new Proxy(storage, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        await enter();
        try {
          return await method.apply(target, args.map(forward));
        } finally {
          leave();
        }
      };
    },
  });
  targets.set(gated, storage);
  return gated;
}

/**
 * Runs `work` - the re-seal of every sealed store from `oldKey` to `newKey` - with the store to
 * itself: calls in flight finish first, new calls wait until it returns. On success the old key is
 * retired to the new one for every later call; on a throw nothing is retired, because the stores are
 * then still (partly) under the old key and the session keeps using it.
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
  const behind = targets.get(storage);
  // A store that was never gated has callers this cannot hold: refuse rather than re-seal under them.
  if (!behind)
    throw new Error('holdStorageForKeyChange: the store was not opened through the gate');
  while (exclusive) await exclusive;
  let release!: () => void;
  exclusive = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    if (active > 0) {
      await new Promise<void>((resolve) => {
        drained = resolve;
      });
    }
    const result = await work(behind);
    retire(oldKey, newKey);
    return result;
  } finally {
    exclusive = null;
    release();
  }
}
