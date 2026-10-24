/**
 * WHAT THIS DEVICE'S SEND RATCHET HAS SPENT, KEPT WHERE A LOST CHECKPOINT CANNOT TAKE IT.
 *
 * Encrypting a frame advances the send ratchet, and the moment that frame is on the wire the peer
 * has consumed the generation. The checkpoint that would make the advance durable is deliberately
 * NOT awaited on the send path - it costs 1.7 s on a phone - so a reload inside that window restores
 * an `mls.bin` that is behind frames which have already left. The next frame then re-issues a spent
 * generation, the peer answers `SecretReuseError`, and a message that was never lost is reported as
 * one and repaired by a full history reconciliation.
 *
 * The repair is to move the ratchet forward to where the peers already believe it is, which needs
 * one number that the lost checkpoint could not take with it. Hence this ledger, and hence
 * `localStorage`: it is the only store that is both SYNCHRONOUS and survives the teardown. An
 * async store would race the very teardown it exists to compensate for - which is exactly how the
 * checkpoint got into this position.
 *
 * Two numbers per group AND EPOCH - a generation belongs to one epoch's ratchet, and a merge starts
 * the next one at 0:
 * - `emitted`   - frames this device has encrypted at that epoch, bumped the instant
 *   `encryptForSend` returns;
 * - `persisted` - what `emitted` was when the last checkpoint was TAKEN.
 *
 * At the restored epoch, `emitted - persisted` is how far the snapshot on disk is behind the peers;
 * at an epoch the snapshot has not reached, all of `emitted` is ({@link sendRatchetDebt}).
 *
 * **THE ORDERING IS THE WHOLE GUARANTEE, AND IT IS ASYMMETRIC ON PURPOSE.** `snapshotEmitted` is
 * read BEFORE `saveState` is called and `commitPersisted` is written AFTER it resolves, so a send
 * landing during the save is counted as unpersisted and burns one generation too many. The other
 * order burns one too few, which IS the defect. Everywhere a choice exists here, it is made the same
 * way, because over-shooting is free and under-shooting is the bug: see
 * `MlsManager::skip_send_generations` for the OpenMLS reading that establishes it.
 *
 * @see docs/wiki/protocols/mls-desync-prevention.md section 8
 */
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * Upper bound on a single burn, matching `maximum_forward_distance` in
 * `mls-core::group::sender_ratchet_config`. Beyond it a receiver answers `TooDistantInTheFuture`, so
 * burning further cannot repair anything - it would only spend time. A deficit this large is a
 * corrupt counter rather than a real backlog of sends, and the cap is reported, never silent.
 */
export const MAX_BURN_GENERATIONS = 2000;

/** Per-group counters. Absent groups read as 0 on both sides. */
interface SendRatchetLedger {
  emitted: Record<string, number>;
  persisted: Record<string, number>;
}

/** One key per user: two accounts in one browser profile must never share a ratchet count. */
function ledgerKey(userId: string): string {
  return ACCOUNT_KEY.sendRatchetLedger(userId);
}

/**
 * Reads the ledger, treating every failure as "no information".
 *
 * A cleared or unreadable store yields a deficit of 0, which burns nothing - no worse than having no
 * ledger at all, which is where this client was before. It is logged rather than swallowed because
 * silently reading zeroes and silently reading a real zero are the same value with different causes.
 */
function read(userId: string): SendRatchetLedger {
  try {
    const raw = localStorage.getItem(ledgerKey(userId));
    if (!raw) return { emitted: {}, persisted: {} };
    const parsed = JSON.parse(raw) as Partial<SendRatchetLedger>;
    return {
      emitted: parsed.emitted ?? {},
      persisted: parsed.persisted ?? {},
    };
  } catch (e) {
    console.warn(
      `[MLS_LEDGER] Send ledger unreadable for ${userId.slice(0, 8)}… - treating it as empty, so nothing will be burnt this load:`,
      String(e).slice(0, 120)
    );
    return { emitted: {}, persisted: {} };
  }
}

/** Writes the ledger. A failure here costs the NEXT load its repair, so it is never silent. */
function write(userId: string, ledger: SendRatchetLedger): void {
  try {
    localStorage.setItem(ledgerKey(userId), JSON.stringify(ledger));
  } catch (e) {
    console.warn(
      `[MLS_LEDGER] Send ledger not written for ${userId.slice(0, 8)}… - a reload before the next checkpoint will not know what to burn:`,
      String(e).slice(0, 120)
    );
  }
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
 * Records that one frame has been encrypted for `groupId` at `epoch` - the epoch the frame itself
 * carries (`sealedFrameEpoch`), never a second read of the state.
 *
 * Called from `BaseMlsService.sendMessage` after `encryptForSend` returns and BEFORE the POST, which
 * is the only correct moment: the ratchet has moved by then, and it stays moved whether or not the
 * POST ever succeeds. Counting on a successful send instead would leave every failed POST as a
 * silent under-count, which is the direction that reproduces the defect.
 */
export function noteFrameEmitted(userId: string, groupId: string, epoch: number): void {
  const ledger = read(userId);
  const key = sendRatchetKey(groupId, epoch);
  ledger.emitted[key] = (ledger.emitted[key] ?? 0) + 1;
  write(userId, ledger);
}

/**
 * The `emitted` counts as they stand right now, to be handed back to {@link commitPersisted} once
 * the checkpoint that is about to be taken has landed. Read BEFORE `saveState` - see the header.
 */
export function snapshotEmitted(userId: string): Record<string, number> {
  return { ...read(userId).emitted };
}

/**
 * Declares that a checkpoint containing exactly `snapshot` has been written durably.
 *
 * Merged rather than replaced, and never allowed to go backwards: a checkpoint that lands out of
 * order must not un-declare what a later one already made durable, and lowering a `persisted` count
 * would manufacture a deficit that burns generations nobody is missing.
 */
export function commitPersisted(userId: string, snapshot: Record<string, number>): void {
  const ledger = read(userId);
  for (const [key, count] of Object.entries(snapshot)) {
    ledger.persisted[key] = Math.max(ledger.persisted[key] ?? 0, count);
  }
  write(userId, ledger);
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

/** Every entry the ledger holds for `userId`. */
export function sendRatchetEntries(userId: string): SendRatchetEntry[] {
  const ledger = read(userId);
  const keys = new Set([...Object.keys(ledger.emitted), ...Object.keys(ledger.persisted)]);
  return [...keys].map((key) => ({
    key,
    ...parseKey(key),
    emitted: ledger.emitted[key] ?? 0,
    persisted: ledger.persisted[key] ?? 0,
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
 * Drops entries by key. Only for entries no ratchet can spend again (a `spent` epoch, a settled
 * pre-epoch entry), and only where no checkpoint is in flight - the load, before anything sends. A
 * straggling `commitPersisted` re-creating one is harmless: it names an epoch behind the state.
 */
export function forgetSendRatchetEntries(userId: string, keys: string[]): void {
  if (keys.length === 0) return;
  const ledger = read(userId);
  for (const key of keys) {
    delete ledger.emitted[key];
    delete ledger.persisted[key];
  }
  write(userId, ledger);
}

/**
 * Forgets everything known about `userId`'s send ratchets.
 *
 * For the seams that REPLACE the state rather than restore it - a fresh start, a device identity
 * rotation - where the new client's ratchets begin at zero and any surviving count would describe a
 * device that no longer exists.
 */
export function resetSendRatchetLedger(userId: string): void {
  try {
    localStorage.removeItem(ledgerKey(userId));
  } catch (e) {
    console.warn(
      `[MLS_LEDGER] Send ledger not cleared for ${userId.slice(0, 8)}…:`,
      String(e).slice(0, 120)
    );
  }
}

/** Test seam: the shape as stored, without going through a read/modify/write. */
export function readSendRatchetLedgerForTest(userId: string): SendRatchetLedger {
  return read(userId);
}
