/**
 * The two bounds on the durable seen-ciphertext ledger (`history_seen_cipher:<user>:<group>`).
 *
 * A ledger holds TWO namespaces in one array, and they answer different questions:
 * - a FINGERPRINT (`frameFingerprint`, `<len36>:<hash36>`) - "I consumed this ratchet generation".
 *   Losing one is what produces a false `unreadable for good` accusation on the next cold start.
 * - a ROW KEY (a Redis stream id, `<ms>-<seq>`) - "I walked this row". Losing one only costs a cheap
 *   re-check against the fingerprints.
 *
 * Before this module one shared cap kept the LAST 5 000 of the mixture, so on the busiest measured
 * conversation 2 762 row keys evicted 2 073 fingerprints - the expensive mark went first. Each
 * namespace now has its own cap, and the NUMBER of ledgers per user is bounded as well (it was not:
 * 169 ledgers, 247 kB on the W1 bench profile, growing with every conversation ever opened).
 *
 * Nothing here reads a clock: eviction order is insertion order inside a ledger and write order
 * across ledgers.
 */

/** Fingerprints kept per group. The busiest measured conversation held 2 073; this leaves 2.4x. */
export const MAX_FINGERPRINTS_PER_LEDGER = 5000;

/** Row keys kept per group. The busiest measured conversation held 2 762; this leaves 1.8x. */
export const MAX_ROW_KEYS_PER_LEDGER = 5000;

/** Ledgers kept per user. 169 were measured on the busiest bench profile; this leaves 1.5x. */
export const MAX_LEDGERS_PER_USER = 256;

/**
 * `frameFingerprint` output: base-36 length, a colon, base-36 hash. A stream id has a dash and no
 * colon, so the two never overlap. The fallback row key for an id-less row (`<ts>:<content>`) is
 * the one shape that holds a colon; it is far longer and carries non-base-36 characters, so it
 * classifies as a row key.
 */
const FINGERPRINT_SHAPE = /^[0-9a-z]{1,8}:[0-9a-z]{1,8}$/;

/** True when an entry is a frame fingerprint rather than an archive row key. */
export function isFingerprintEntry(entry: string): boolean {
  return FINGERPRINT_SHAPE.test(entry);
}

/**
 * Applies the per-namespace caps to a ledger in insertion order, oldest entries of an over-full
 * namespace first. Relative order of everything kept is preserved, so a later cut still evicts the
 * oldest.
 */
export function boundSeenEntries(entries: Iterable<string>): string[] {
  const all = [...entries];
  let fingerprints = 0;
  let rows = 0;
  const keep: boolean[] = Array.from({ length: all.length }, () => false);
  for (let i = all.length - 1; i >= 0; i--) {
    if (isFingerprintEntry(all[i])) {
      keep[i] = fingerprints < MAX_FINGERPRINTS_PER_LEDGER;
      fingerprints++;
    } else {
      keep[i] = rows < MAX_ROW_KEYS_PER_LEDGER;
      rows++;
    }
  }
  return all.filter((_, i) => keep[i]);
}

const LEDGER_PREFIX = 'history_seen_cipher:';

function ledgerIndexKey(userId: string): string {
  return `history_seen_cipher_index:${userId}`;
}

/**
 * The user's ledgers, oldest write first. The persisted index is the answer; when there is none
 * (a profile from before this bound) the existing ledger keys are enumerated once, in storage order.
 */
function readLedgerIndex(userId: string): string[] {
  const raw = localStorage.getItem(ledgerIndexKey(userId));
  if (raw !== null) {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((g): g is string => typeof g === 'string');
  }
  const prefix = `${LEDGER_PREFIX}${userId}:`;
  const groups: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) groups.push(key.slice(prefix.length));
  }
  return groups;
}

/**
 * Records that `groupId`'s ledger was just written, and returns the groups whose ledgers fell over
 * the per-user cap (least recently written first) so the caller can delete them. The group being
 * written is never among them. A failure is logged and answers "evict nothing" - an unreadable
 * index must not take a ledger down with it.
 */
export function noteLedgerWritten(userId: string, groupId: string): string[] {
  try {
    const index = readLedgerIndex(userId).filter((g) => g !== groupId);
    index.push(groupId);
    const evicted =
      index.length > MAX_LEDGERS_PER_USER
        ? index.splice(0, index.length - MAX_LEDGERS_PER_USER)
        : [];
    localStorage.setItem(ledgerIndexKey(userId), JSON.stringify(index));
    if (evicted.length > 0) {
      console.warn(
        `[HISTORY] ${evicted.length} least recently written seen-ciphertext ledger(s) dropped, ` +
          `over the ${MAX_LEDGERS_PER_USER}-per-user cap - their groups re-walk their archive once`
      );
    }
    return evicted;
  } catch (err) {
    console.warn(
      `[HISTORY] The seen-ledger index was not updated, no ledger evicted: ${String(err)}`
    );
    return [];
  }
}
