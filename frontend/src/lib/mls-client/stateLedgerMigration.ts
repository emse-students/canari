/**
 * MOVES THE LEDGERS A CLIENT BEFORE 2026-10-26 KEPT IN `localStorage` INTO THE MLS STATE, ONCE.
 *
 * Until then the seen-ciphertext marks (`history_seen_cipher:<user>:<group>` and their index) and
 * the send ledger (`mls_send_ledger_<user>`) lived in `localStorage`, which a browser commits to
 * disk seconds after a write (KILL-2). They now live in the state they describe (`stateLedgers.ts`)
 * and, for the send ledger's `emitted` half, in IndexedDB (`sendRatchetLedger.ts`).
 *
 * ONE PASS, AND ITS OWN RECORD SAYS WHETHER IT RAN. A state carrying {@link STATE_LEDGER.format}
 * holds the ledgers; one without it is either a fresh state or one written by an older client, and
 * in both cases the old copies - if any - are staged into it. The old copies are deleted only at the
 * NEXT opening of a state that carries the format: a kill before the first checkpoint lands leaves
 * them where they were, and that next opening simply migrates them again. Nothing reads them in
 * between, so there is never a second source of the same fact.
 *
 * No loss in either direction, and the reason is the order the old client wrote them in: both
 * ledgers were written AFTER the checkpoint they describe, so a surviving old value is never AHEAD
 * of the state it is moved into - at worst behind it, which is what this change exists to stop
 * happening again, and what an over-burn or a re-accusation already tolerated.
 *
 * Legacy compatibility (`docs/wiki/legacy-compatibility.md`): goes once every account still on a
 * client older than this one has opened its state on a newer one.
 */
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import {
  readStateLedger,
  stageStateLedger,
  stateLedgerKeys,
  STATE_LEDGER,
  STATE_LEDGER_FORMAT,
} from './stateLedgers';
import { raiseEmittedCounts, stagePersisted, type SendCounts } from './sendRatchetLedger';

/** Every old `localStorage` key of `userId` this migration owns. */
function legacyKeys(userId: string): string[] {
  const seenPrefix = ACCOUNT_KEY.seenCipher(userId, '');
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(seenPrefix)) keys.push(key);
  }
  for (const key of [ACCOUNT_KEY.seenCipherIndex(userId), ACCOUNT_KEY.sendRatchetLedger(userId)]) {
    if (localStorage.getItem(key) !== null) keys.push(key);
  }
  return keys;
}

/** A stored JSON value, or undefined - with a line, because an unreadable ledger is a lost one. */
function parsed(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(
      `[LEDGER] old ledger ${key} is unreadable - not migrated:`,
      String(e).slice(0, 120)
    );
    return undefined;
  }
}

/** The numeric counts of an old send-ledger half. */
function oldCounts(raw: unknown): SendCounts {
  const out: SendCounts = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) out[key] = value;
  }
  return out;
}

/**
 * Takes the old ledgers into the opened state, or deletes them once the state already holds the
 * ledgers. Called by `BaseMlsService` right after {@link hydrateStateLedgers}, before anything reads
 * a ledger or sends.
 *
 * @returns what it did, for the caller's one line
 */
export async function adoptLegacyLedgers(
  userId: string
): Promise<'migrated' | 'swept' | 'nothing'> {
  const keys = legacyKeys(userId);
  if (readStateLedger(userId, STATE_LEDGER.format) !== undefined) {
    if (keys.length === 0) return 'nothing';
    for (const key of keys) localStorage.removeItem(key);
    console.log(
      `[LEDGER] the MLS state carries the ledgers - ${keys.length} old localStorage copy(ies) deleted`
    );
    return 'swept';
  }

  // The send ledger FIRST and AWAITED: `emitted` is the half whose loss re-issues a generation, so
  // it is on disk in its new store before anything else of this pass is staged.
  const send = parsed(ACCOUNT_KEY.sendRatchetLedger(userId)) as
    | { emitted?: unknown; persisted?: unknown }
    | undefined;
  if (send) {
    await raiseEmittedCounts(userId, oldCounts(send.emitted));
    stagePersisted(userId, oldCounts(send.persisted));
  }

  const seenPrefix = ACCOUNT_KEY.seenCipher(userId, '');
  let seenLedgers = 0;
  for (const key of keys) {
    if (!key.startsWith(seenPrefix)) continue;
    const groupId = key.slice(seenPrefix.length);
    const entries = parsed(key);
    if (!Array.isArray(entries)) continue;
    // A ledger the state already holds for this group is newer than the old copy: kept.
    if (readStateLedger(userId, STATE_LEDGER.seen(groupId)) !== undefined) continue;
    stageStateLedger(
      userId,
      STATE_LEDGER.seen(groupId),
      JSON.stringify(entries.filter((e): e is string => typeof e === 'string'))
    );
    seenLedgers++;
  }
  const index = parsed(ACCOUNT_KEY.seenCipherIndex(userId));
  if (Array.isArray(index) && readStateLedger(userId, STATE_LEDGER.seenIndex) === undefined) {
    const held = new Set(
      stateLedgerKeys(userId, STATE_LEDGER.seenPrefix).map((k) =>
        k.slice(STATE_LEDGER.seenPrefix.length)
      )
    );
    stageStateLedger(
      userId,
      STATE_LEDGER.seenIndex,
      JSON.stringify(index.filter((g): g is string => typeof g === 'string' && held.has(g)))
    );
  }
  stageStateLedger(userId, STATE_LEDGER.format, STATE_LEDGER_FORMAT);
  if (keys.length === 0) return 'nothing';
  console.log(
    `[LEDGER] ${seenLedgers} seen-ciphertext ledger(s)${send ? ' and the send ledger' : ''} moved from localStorage into the MLS state - the old copies go at the next opening`
  );
  return 'migrated';
}
