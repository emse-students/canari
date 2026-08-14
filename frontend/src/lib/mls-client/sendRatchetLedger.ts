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
 * Two numbers per group:
 * - `emitted`   - frames this device has encrypted, bumped the instant `encryptForSend` returns;
 * - `persisted` - what `emitted` was when the last checkpoint was TAKEN.
 *
 * `emitted - persisted` is how far the snapshot on disk is behind the peers.
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
  return `mls_send_ledger_${userId}`;
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
 * Records that one frame has been encrypted for `groupId`.
 *
 * Called from `BaseMlsService.sendMessage` after `encryptForSend` returns and BEFORE the POST, which
 * is the only correct moment: the ratchet has moved by then, and it stays moved whether or not the
 * POST ever succeeds. Counting on a successful send instead would leave every failed POST as a
 * silent under-count, which is the direction that reproduces the defect.
 */
export function noteFrameEmitted(userId: string, groupId: string): void {
  const ledger = read(userId);
  ledger.emitted[groupId] = (ledger.emitted[groupId] ?? 0) + 1;
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
  for (const [groupId, count] of Object.entries(snapshot)) {
    ledger.persisted[groupId] = Math.max(ledger.persisted[groupId] ?? 0, count);
  }
  write(userId, ledger);
}

/** A group whose on-disk state is behind the frames this device has already sent. */
export interface SendRatchetDeficit {
  groupId: string;
  /** Generations to burn. Already clamped to {@link MAX_BURN_GENERATIONS}. */
  deficit: number;
  /** True when the clamp bit, so the caller can say so rather than quietly burning fewer. */
  clamped: boolean;
}

/**
 * Groups whose restored snapshot is behind the peers, with how far.
 *
 * Only positive deficits are returned. A NEGATIVE one is normal and means the state on disk is
 * AHEAD of this ledger - the Android/iOS background sender persists inside its own batch
 * (`send_messages_background_with_key`) without ever touching localStorage, so a device that sent
 * while backgrounded lands here. Nothing to repair in that direction.
 */
export function pendingSendGenerations(userId: string): SendRatchetDeficit[] {
  const ledger = read(userId);
  const out: SendRatchetDeficit[] = [];
  for (const [groupId, emitted] of Object.entries(ledger.emitted)) {
    const raw = emitted - (ledger.persisted[groupId] ?? 0);
    if (raw <= 0) continue;
    out.push({
      groupId,
      deficit: Math.min(raw, MAX_BURN_GENERATIONS),
      clamped: raw > MAX_BURN_GENERATIONS,
    });
  }
  return out;
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
