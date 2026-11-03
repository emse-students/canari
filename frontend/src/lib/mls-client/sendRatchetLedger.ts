/**
 * WHAT THIS DEVICE'S SEND RATCHET HAS SPENT, KEPT WHERE A LOST CHECKPOINT CANNOT TAKE IT.
 *
 * Encrypting a frame advances the send ratchet, and the moment that frame is on the wire the peer
 * has consumed the generation. The checkpoint that would make the advance durable is deliberately
 * NOT awaited on the send path - it costs 1.7 s on a phone - so a reload inside that window restores
 * a state that is behind frames which have already left. The next frame then re-issues a spent
 * generation, the peer answers `SecretReuseError`, and a message that was never lost is reported as
 * one and repaired by a full history reconciliation.
 *
 * The repair is to move the ratchet forward to where the peers already believe it is, which needs
 * two numbers per group AND EPOCH - a generation belongs to one epoch's ratchet, and a merge starts
 * the next one at 0:
 *
 * - `emitted`   - frames this device has encrypted at that epoch. In IndexedDB, written BEFORE the
 *   frame is posted and AWAITED: it must be on disk before the peer can consume the generation, which
 *   is earlier than any checkpoint (2026-10-26). It was in `localStorage` until then, chosen as "the
 *   store that survives the teardown" - it survives a TAB's, not the browser's or the app's process
 *   dying inside the seconds `localStorage` waits before committing (KILL-2), and losing it is the
 *   re-issue this ledger exists to prevent.
 * - `persisted` - what `emitted` was when the checkpoint holding those advances was TAKEN. INSIDE the
 *   MLS state (`stateLedgers.ts`), applied to the client before it exports, so the number on disk is
 *   always the one true of the state on disk.
 *
 * At the restored epoch, `emitted - persisted` is how far the state on disk is behind the peers; at
 * an epoch the state has not reached, all of `emitted` is ({@link sendRatchetDebt}).
 *
 * **WRONG IN ONE DIRECTION ONLY, ON PURPOSE.** `emitted` is read BEFORE the export and every send is
 * counted before it is posted, so the two stores can only over-state the debt: a send landing during
 * a checkpoint is counted as unpersisted and burns one generation too many. Under-stating it IS the
 * defect. See `MlsManager::skip_send_generations` for the OpenMLS reading that makes over-shooting
 * free.
 *
 * @see docs/wiki/protocols/mls-desync-prevention.md section 8
 */
import { readMlsDbRecord, updateMlsDbRecord } from '$lib/utils/hex';
import {
  readStateLedger,
  stageStateLedger,
  stateLedgersHydrated,
  STATE_LEDGER,
} from './stateLedgers';

/**
 * Upper bound on a single burn, matching `maximum_forward_distance` in
 * `mls-core::group::sender_ratchet_config`. Beyond it a receiver answers `TooDistantInTheFuture`, so
 * burning further cannot repair anything - it would only spend time. A deficit this large is a
 * corrupt counter rather than a real backlog of sends, and the cap is reported, never silent.
 */
export const MAX_BURN_GENERATIONS = 2000;

/** Counts by ledger key ({@link sendRatchetKey}). Absent keys read as 0. */
export type SendCounts = Record<string, number>;

/**
 * The IndexedDB record holding `userId`'s `emitted` counts. The account is in the key as well as in
 * the database name: two accounts in one profile must never share a ratchet count.
 */
export function sendEmittedRecordKey(userId: string): string {
  return `send_ratchet_emitted:${userId}`;
}

/** Keeps only finite, non-negative integer counts - what a stored value must be to be believed. */
function countsOf(raw: unknown): SendCounts {
  const out: SendCounts = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

/**
 * The ledger key of `groupId`'s send ratchet AT `epoch`. A generation is a property of one epoch's
 * ratchet: a merge starts the next epoch at generation 0, so a count kept per group alone cannot say
 * which ratchet its frames spent - and a burn applied to the wrong one repairs nothing. Exported so a
 * checkpoint can leave out of what it declares durable the ratchets it does not hold the repair of.
 */
export function sendRatchetKey(groupId: string, epoch: number): string {
  return `${groupId}@${epoch}`;
}

/**
 * A burn owed to `groupId` at `epoch` did not run, so a frame sealed now would re-use a generation
 * the peers consumed (`SecretReuseError` on every one of them). The send is REFUSED instead; the debt
 * stays owed, so the next send - or the next load, which reads the ledger again - burns it.
 */
export class OwedSendBurnFailedError extends Error {
  constructor(
    readonly groupId: string,
    readonly epoch: number,
    readonly cause: unknown
  ) {
    super(
      `the send ratchet of ${groupId.slice(0, 8)}... at epoch ${epoch} owes a burn that failed - nothing is sealed until it runs`
    );
    this.name = 'OwedSendBurnFailedError';
  }
}

/**
 * The count of a frame just sealed could not be made durable, so the frame is NOT posted: once a
 * peer consumed its generation, a reload that does not know of it re-issues that generation. The
 * ratchet has moved in memory, which skips one generation nobody will read - free.
 */
export class SendCountNotDurableError extends Error {
  constructor(
    readonly groupId: string,
    readonly epoch: number,
    readonly cause: unknown
  ) {
    super(
      `the frame sealed for ${groupId.slice(0, 8)}... at epoch ${epoch} was not posted - its count did not reach the disk: ${String(cause).slice(0, 120)}`
    );
    this.name = 'SendCountNotDurableError';
  }
}

/**
 * Reads a key back. A key with no `@<epoch>` was written by a client before 2026-10-23, which counted
 * per group: its frames are counted against the epoch the restored state is at, as that client did
 * (`docs/wiki/legacy-compatibility.md`).
 */
function parseKey(key: string): { groupId: string; epoch: number | null } {
  const at = key.lastIndexOf('@');
  if (at < 0) return { groupId: key, epoch: null };
  const epoch = Number(key.slice(at + 1));
  if (!Number.isSafeInteger(epoch)) return { groupId: key, epoch: null };
  return { groupId: key.slice(0, at), epoch };
}

/**
 * Records, DURABLY, that one frame has been encrypted for `groupId` at `epoch` - the epoch the frame
 * itself carries (`sealedFrameEpoch`), never a second read of the state.
 *
 * Awaited by `BaseMlsService.sendMessage` after `encryptForSend` returns and BEFORE the POST, which
 * is the only correct moment: the ratchet has moved by then, and it stays moved whether or not the
 * POST ever succeeds. Counting on a successful send instead would leave every failed POST as a
 * silent under-count, which is the direction that reproduces the defect.
 *
 * @throws SendCountNotDurableError when the count did not commit - the caller must not post
 */
export async function noteFrameEmitted(
  userId: string,
  groupId: string,
  epoch: number
): Promise<void> {
  const key = sendRatchetKey(groupId, epoch);
  try {
    await updateMlsDbRecord<SendCounts>(userId, sendEmittedRecordKey(userId), (previous) => {
      const counts = countsOf(previous);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    });
  } catch (e) {
    console.error(
      `[MLS_LEDGER] The send count for ${groupId.slice(0, 8)}... at epoch ${epoch} did not commit - the frame is not posted:`,
      String(e).slice(0, 160)
    );
    throw new SendCountNotDurableError(groupId, epoch, e);
  }
}

/**
 * The `emitted` counts as they stand on disk now - read BEFORE the checkpoint's export, so a send
 * landing after this read is counted as unpersisted (see the header).
 */
export async function readEmitted(userId: string): Promise<SendCounts> {
  return countsOf(await readMlsDbRecord<unknown>(userId, sendEmittedRecordKey(userId)));
}

/** The `persisted` counts the opened state carries. */
function readPersisted(userId: string): SendCounts {
  const raw = readStateLedger(userId, STATE_LEDGER.sendPersisted);
  if (raw === undefined) return {};
  try {
    return countsOf(JSON.parse(raw));
  } catch (e) {
    // Read as nothing persisted: the next load over-burns, which is free. Said, because a silent
    // zero and a real zero are the same value with different causes.
    console.warn(
      `[MLS_LEDGER] The persisted send counts in the MLS state are unreadable for ${userId.slice(0, 8)}... - reading none, so the next load burns everything counted:`,
      String(e).slice(0, 120)
    );
    return {};
  }
}

/**
 * Stages, INTO THE STATE ABOUT TO BE EXPORTED, that it holds the advances counted in `snapshot`.
 *
 * Merged rather than replaced, and never allowed to go backwards: lowering a `persisted` count would
 * manufacture a deficit that burns generations nobody is missing. Nothing staged when nothing moves,
 * so a checkpoint with no send behind it writes no ledger.
 */
export function stagePersisted(userId: string, snapshot: SendCounts): void {
  const persisted = readPersisted(userId);
  let moved = false;
  for (const [key, count] of Object.entries(snapshot)) {
    if (count > (persisted[key] ?? 0)) {
      persisted[key] = count;
      moved = true;
    }
  }
  if (moved) stageStateLedger(userId, STATE_LEDGER.sendPersisted, JSON.stringify(persisted));
}

/** One group's send ratchet at one epoch, as the ledger knows it. */
export interface SendRatchetEntry {
  /** The stored key, for {@link forgetSendRatchetEntries}. */
  key: string;
  groupId: string;
  /** The epoch the frames were sealed at; `null` for an entry written before epochs were kept. */
  epoch: number | null;
  emitted: number;
  persisted: number;
}

/** Every entry the ledger holds for `userId`: `emitted` from IndexedDB, `persisted` from the state. */
export async function sendRatchetEntries(userId: string): Promise<SendRatchetEntry[]> {
  const emitted = await readEmitted(userId);
  const persisted = readPersisted(userId);
  const keys = new Set([...Object.keys(emitted), ...Object.keys(persisted)]);
  return [...keys].map((key) => ({
    key,
    ...parseKey(key),
    emitted: emitted[key] ?? 0,
    persisted: persisted[key] ?? 0,
  }));
}

/**
 * What one entry owes a state restored at `restoredEpoch` for its group.
 *
 * - `burn-now`: the entry's epoch IS the restored one (or the entry predates epochs). The snapshot
 *   holds that ratchet as it was at the last checkpoint, so the debt is `emitted - persisted`.
 * - `on-arrival`: the entry's epoch is AHEAD of the restored state - frames sent after a merge the
 *   snapshot does not hold. That epoch's ratchet starts at generation 0 again when the group gets
 *   there (the settle of its own staged commit, or a replayed one), so EVERY frame counted in it is
 *   owed, and owed THERE: burnt at the restored epoch, it moved a ratchet nobody would read.
 * - `spent`: the epoch is behind the restored state. Nothing can send in it again; the entry is
 *   dead weight.
 * - `settled`: nothing is owed.
 *
 * Positive debts are clamped to {@link MAX_BURN_GENERATIONS}, and say so.
 */
export type SendRatchetDebt =
  | { kind: 'burn-now'; count: number; clamped: boolean }
  | { kind: 'on-arrival'; count: number; clamped: boolean }
  | { kind: 'spent' }
  | { kind: 'settled' };

export function sendRatchetDebt(entry: SendRatchetEntry, restoredEpoch: number): SendRatchetDebt {
  if (entry.epoch !== null && entry.epoch < restoredEpoch) return { kind: 'spent' };
  const ahead = entry.epoch !== null && entry.epoch > restoredEpoch;
  const raw = ahead ? entry.emitted : entry.emitted - entry.persisted;
  if (raw <= 0) return { kind: 'settled' };
  return {
    kind: ahead ? 'on-arrival' : 'burn-now',
    count: Math.min(raw, MAX_BURN_GENERATIONS),
    clamped: raw > MAX_BURN_GENERATIONS,
  };
}

/**
 * Drops entries by key, from both stores. Only for entries no ratchet can spend again (a `spent`
 * epoch, a settled pre-epoch entry), and only where nothing sends - the load, before anything can.
 * Either half surviving the other is harmless: a lone `emitted` for a spent epoch is `spent` again
 * next load, a lone `persisted` is `settled`.
 */
export async function forgetSendRatchetEntries(userId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await updateMlsDbRecord<SendCounts>(userId, sendEmittedRecordKey(userId), (previous) => {
    const counts = countsOf(previous);
    for (const key of keys) delete counts[key];
    return Object.keys(counts).length === 0 ? undefined : counts;
  });
  const persisted = readPersisted(userId);
  const before = Object.keys(persisted).length;
  for (const key of keys) delete persisted[key];
  if (Object.keys(persisted).length !== before) {
    stageStateLedger(
      userId,
      STATE_LEDGER.sendPersisted,
      Object.keys(persisted).length === 0 ? null : JSON.stringify(persisted)
    );
  }
}

/**
 * Forgets everything known about `userId`'s send ratchets.
 *
 * For the seams that REPLACE the state rather than restore it - a fresh start, a device identity
 * rotation - where the new client's ratchets begin at zero and any surviving count would describe a
 * device that no longer exists.
 */
export async function resetSendRatchetLedger(userId: string): Promise<void> {
  await updateMlsDbRecord<SendCounts>(userId, sendEmittedRecordKey(userId), () => undefined);
  // Before the state opened (a rotation inside the load) there is no view to clear: the state being
  // opened is the fresh one, which holds none.
  if (
    stateLedgersHydrated(userId) &&
    readStateLedger(userId, STATE_LEDGER.sendPersisted) !== undefined
  ) {
    stageStateLedger(userId, STATE_LEDGER.sendPersisted, null);
  }
}

/**
 * Raises the durable `emitted` counts to at least `counts` - the one way counts written by an older
 * client (`localStorage`) enter this store (`stateLedgerMigration.ts`). Never lowers one.
 */
export async function raiseEmittedCounts(userId: string, counts: SendCounts): Promise<void> {
  const incoming = countsOf(counts);
  if (Object.keys(incoming).length === 0) return;
  await updateMlsDbRecord<SendCounts>(userId, sendEmittedRecordKey(userId), (previous) => {
    const merged = countsOf(previous);
    for (const [key, count] of Object.entries(incoming)) {
      merged[key] = Math.max(merged[key] ?? 0, count);
    }
    return merged;
  });
}
