/**
 * THE APP'S LEDGERS THAT DESCRIBE THE MLS STATE, KEPT INSIDE IT (KILL-2, 2026-10-26).
 *
 * Two records exist only to describe the ratchets the MLS state holds: the seen-ciphertext marks
 * (`history.ts`: "this device consumed the generation that decrypted this frame") and the send
 * ledger's `persisted` counts (`sendRatchetLedger.ts`: "this state holds the advance of N frames sent
 * at epoch E"). Each is true only of the state it was written beside.
 *
 * They lived in `localStorage`, which the browser commits to disk SECONDS after a write, while the
 * state is durable when its checkpoint completes. A browser or app killed in that delay came back
 * with a ratchet ahead of its marks, and the next history walk accused a frame it had read of being
 * lost (measured by KILL-2, 2026-10-25). No ordering of two stores closes that window, so the
 * ledgers are written INTO the state (`mls-core/src/app_ledgers.rs`): one document, one seal, one
 * write, on both platforms and through every writer of the state.
 *
 * How a value gets there:
 *
 * 1. at the state's opening, {@link hydrateStateLedgers} takes the ledgers the state carries;
 * 2. a writer {@link stageStateLedger}s a new value - this view answers reads at once;
 * 3. `BaseMlsService.persistCheckpoint` {@link takeStagedStateLedgers} and hands them to the platform's
 *    checkpoint, which applies them to the live client BEFORE it exports, so the export holds them
 *    beside every ratchet advance they can describe;
 * 4. a checkpoint that throws {@link restageStateLedgers}, so the next one carries them.
 *
 * The live client keeps what was applied; a swap carries it to the client that replaces it
 * (`adopt_app_ledgers`). So the view here and the state agree from the first checkpoint on.
 *
 * @see docs/wiki/protocols/mls-desync-prevention.md section 8
 */

/**
 * Every key this app writes into the state. One namespace, owned here, so two writers cannot pick
 * the same name.
 */
export const STATE_LEDGER = {
  /** Present once this state carries the ledgers; absent means "migrate the old copies". */
  format: 'ledger-format',
  /** A group's seen-ciphertext marks, a JSON array (`history.ts`). */
  seen: (groupId: string): string => `seen:${groupId}`,
  /** The prefix every {@link STATE_LEDGER.seen} key starts with. */
  seenPrefix: 'seen:',
  /** The groups holding a seen ledger, least recently written first (`seenLedgerBounds.ts`). */
  seenIndex: 'seen-index',
  /** What each send ratchet's advance this state holds, by `group@epoch` (`sendRatchetLedger.ts`). */
  sendPersisted: 'send-persisted',
} as const;

/** The value of {@link STATE_LEDGER.format} this build writes. */
export const STATE_LEDGER_FORMAT = '1';

/** A checkpoint's batch: a string sets a key, `null` removes it. */
export type StateLedgerChanges = Record<string, string | null>;

/** The ledgers as this document knows them: hydrated, then every staged value on top. */
const views = new Map<string, Map<string, string>>();

/** Values staged since the last checkpoint took them, per account. */
const staged = new Map<string, Map<string, string | null>>();

/**
 * Takes the ledgers the opened state carries as this document's view, and drops anything staged
 * for the account before it - a staging made against another copy of the state describes nothing
 * the opened one holds.
 */
export function hydrateStateLedgers(userId: string, entries: Record<string, string>): void {
  views.set(userId, new Map(Object.entries(entries)));
  staged.delete(userId);
  console.log(
    `[LEDGER] opened the ledgers the MLS state carries for ${userId.slice(0, 8)}... - ${Object.keys(entries).length} key(s)`
  );
}

/**
 * Closes `userId`'s view because a state is about to be LOADED: what it holds, and anything staged
 * on it, describes the copy of the state an earlier load opened, not the one coming. Until
 * {@link hydrateStateLedgers} nothing can be staged or read, so a checkpoint the load itself takes
 * (a fresh start, a rotation) writes no ledger it would have to take back.
 */
export function closeStateLedgers(userId: string): void {
  views.delete(userId);
  staged.delete(userId);
}

/** Whether the state has been opened for `userId` in this document, so its ledgers can be read. */
export function stateLedgersHydrated(userId: string): boolean {
  return views.has(userId);
}

/**
 * The value of `key`, or undefined when the state holds none.
 *
 * A read before the state opened answers undefined AND SAYS SO: it is a reader running ahead of the
 * login, and the empty answer it gets would make it re-walk what it already holds.
 */
export function readStateLedger(userId: string, key: string): string | undefined {
  const view = views.get(userId);
  if (!view) {
    console.error(
      `[LEDGER] ${key} read for ${userId.slice(0, 8)}... before the MLS state opened - answering nothing; the caller runs ahead of the login`
    );
    return undefined;
  }
  return view.get(key);
}

/** Every key of the view starting with `prefix`, in the order the view holds them. */
export function stateLedgerKeys(userId: string, prefix: string): string[] {
  const view = views.get(userId);
  if (!view) return [];
  return [...view.keys()].filter((k) => k.startsWith(prefix));
}

/**
 * Stages `value` for `key` (`null` removes it): read back at once, written by the next checkpoint.
 *
 * REFUSED, LOUDLY, BEFORE THE STATE OPENED: there is no state to carry it yet, and a value staged
 * then would be dropped by the opening anyway ({@link hydrateStateLedgers}).
 */
export function stageStateLedger(userId: string, key: string, value: string | null): void {
  const view = views.get(userId);
  if (!view) {
    console.error(
      `[LEDGER] ${key} staged for ${userId.slice(0, 8)}... before the MLS state opened - not kept; the writer runs ahead of the login`
    );
    return;
  }
  if (value === null) view.delete(key);
  else view.set(key, value);
  let batch = staged.get(userId);
  if (!batch) {
    batch = new Map();
    staged.set(userId, batch);
  }
  batch.set(key, value);
}

/**
 * Hands every staged value to the checkpoint that is about to export the state, and forgets it
 * here: the client it is applied to keeps it from then on. Undefined when nothing is staged.
 */
export function takeStagedStateLedgers(userId: string): StateLedgerChanges | undefined {
  const batch = staged.get(userId);
  if (!batch || batch.size === 0) return undefined;
  staged.delete(userId);
  return Object.fromEntries(batch);
}

/**
 * A checkpoint that took `changes` threw: stage them again so the next one carries them.
 *
 * With the view's CURRENT value, never the batch's: a key staged again since is newer, and the view
 * holds exactly that. Re-applying a value the client already took is a no-op there.
 */
export function restageStateLedgers(userId: string, changes: StateLedgerChanges): void {
  const view = views.get(userId);
  if (!view) return;
  let batch = staged.get(userId);
  if (!batch) {
    batch = new Map();
    staged.set(userId, batch);
  }
  for (const key of Object.keys(changes)) {
    if (batch.has(key)) continue;
    batch.set(key, view.get(key) ?? null);
  }
}

/**
 * Stages the WHOLE view, but `except`, for a client that holds none of it: the fresh state of a
 * device identity rotation, whose first checkpoint must carry what this document already knows.
 */
export function restageWholeStateLedgerView(userId: string, except: readonly string[]): void {
  const view = views.get(userId);
  if (!view) return;
  for (const [key, value] of view) {
    if (except.includes(key)) continue;
    stageStateLedger(userId, key, value);
  }
}

/** @internal Clears every view and batch between Vitest cases. */
export function resetStateLedgersForTests(): void {
  views.clear();
  staged.clear();
}
