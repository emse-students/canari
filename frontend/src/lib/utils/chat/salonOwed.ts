/**
 * SALON WRITES OWED TO THE NEXT RECONNECT (WP-OFF-3, WP-OFF-4): a send, an edit, a reaction, a pin
 * or a vote that met no answer while the device was offline, or was held because it was.
 *
 * The reconnect (`connectivity.onReconnect`: the browser's `online`, or the server answering again
 * after a transport failure) is the event that changes the answer, so it is the only trigger - never
 * a clock. Each write is registered under a KEY naming what it decides (`send:<id>`,
 * `pin:<message>`, ...), and a later write under the same key REPLACES the owed one: a pin then an
 * unpin made offline owe the unpin alone, and a vote changed twice owes the last choice.
 *
 * Every write here is safe to repeat - a send and a sealed row by their client id, which the server
 * answers with the row it holds (migration 088); a pin and a vote because they SET a state - so a
 * write that did land before its answer was lost costs nothing when it goes again.
 *
 * Memory only, on purpose: a pin or a vote replayed the next day would overwrite whatever the
 * community decided since, and a send's durable half is the unsent ledger (`salonUnsent.ts`).
 */
import { connectivity } from '$lib/stores/connectivity.svelte';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { refusalStatus } from '$lib/utils/apiRefusal';
import { GraineSealUnavailableError } from '$lib/utils/graine/sealUnavailable';

/** One owed write: delivers it and classifies its own outcome (it may owe itself again). */
export type OwedSalonWrite = () => Promise<void>;

const owed = new Map<string, OwedSalonWrite>();
let stopOnReconnect: (() => void) | null = null;

/** Owes `write` to the next reconnect under `key`, replacing anything already owed under it. */
export function oweSalonWrite(key: string, write: OwedSalonWrite): void {
  if (owed.has(key)) console.debug(`[SALON-OWED] ${key} replaced by a later write`);
  owed.set(key, write);
  if (stopOnReconnect) return;
  stopOnReconnect = connectivity.onReconnect(() => void deliverOwedSalonWrites());
}

/** Whether a write is owed under `key` - a later gesture on the same thing replaces it. */
export function isSalonWriteOwed(key: string): boolean {
  return owed.has(key);
}

/** Forgets the write owed under `key`: its author gave it up, or a later answer settled it. */
export function forgetOwedSalonWrite(key: string): void {
  owed.delete(key);
}

/**
 * Delivers every owed write. The set is emptied BEFORE any goes, so a reconnect landing during the
 * delivery cannot send one twice, and a write that meets the link down again owes itself to the NEXT
 * reconnect. One write's failure is logged and never stops the others.
 */
export async function deliverOwedSalonWrites(): Promise<void> {
  const writes = [...owed];
  owed.clear();
  stopOnReconnect?.();
  stopOnReconnect = null;
  if (writes.length === 0) return;
  console.log(`[SALON-OWED] reconnect: ${writes.length} salon write(s) owed, delivered again`);
  await Promise.all(
    writes.map(async ([key, write]) => {
      try {
        await write();
      } catch (e) {
        console.error(`[SALON-OWED] owed write ${key} threw on delivery:`, e);
      }
    })
  );
}

/** Where one salon write ended: sent, owed to the reconnect, or failed with `error`. */
export type SalonWriteOutcome =
  | { kind: 'sent' }
  | { kind: 'owed' }
  | { kind: 'failed'; error: unknown };

/**
 * Delivers one salon write (WP-OFF-4: an edit, a reaction, a pin, a vote), owing it to the reconnect
 * instead of failing it whenever the link is down - checked BEFORE the attempt (an offline device
 * seals nothing and posts nothing), and after a transport failure that left the store offline (set
 * by that very failure, `trackedFetch` reporting it before it rethrows). A write owed and delivered
 * later settles through the same `settle`, so its caller writes its outcome handling once.
 *
 * Every other failure is `failed` and the caller decides, with {@link nothingLeftTheDevice}, whether
 * its optimistic local state must be taken back.
 */
export async function deliverSalonWrite(
  key: string,
  attempt: () => Promise<void>,
  settle: (outcome: SalonWriteOutcome) => void
): Promise<void> {
  const owe = (why: string) => {
    console.log(`[SALON-OWED] ${key} owed to the reconnect: ${why}`);
    oweSalonWrite(key, () => deliverSalonWrite(key, attempt, settle));
    settle({ kind: 'owed' });
  };
  if (connectivity.isOffline) {
    owe('the device is offline');
    return;
  }
  try {
    await attempt();
  } catch (error) {
    if (isTransportFailure(error) && connectivity.isOffline) {
      owe(`no answer and the device went offline (${String(error)})`);
      return;
    }
    settle({ kind: 'failed', error });
    return;
  }
  settle({ kind: 'sent' });
}

/**
 * Whether a failed salon write left NOTHING the server or a peer may hold - the only case where its
 * optimistic local state is taken back ("rollback only when nothing is left", WP-OFF-4): a seal this
 * device could not make, an answer below 500 (the server refused before storing), or no answer with
 * the link still up (nothing left the device that anyone acknowledged). A 5xx may come from a proxy
 * AFTER the write was stored, so it is NOT nothing.
 */
export function nothingLeftTheDevice(error: unknown): boolean {
  if (error instanceof GraineSealUnavailableError) return true;
  if (isTransportFailure(error)) return true;
  const status = refusalStatus(error);
  return status !== null && status < 500;
}

/** Drops every owed write: the session that owed them ended. */
export function resetOwedSalonWrites(): void {
  if (owed.size > 0) console.log(`[SALON-OWED] ${owed.size} owed write(s) dropped: session ended`);
  owed.clear();
  stopOnReconnect?.();
  stopOnReconnect = null;
}
