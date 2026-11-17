/**
 * The two bounds on the durable seen-ciphertext ledger (`seen:<group>`, carried in the MLS state).
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
import {
  APP_LEDGERS_BYTE_BUDGET,
  readStateLedger,
  stageStateLedger,
  stateLedgerKeys,
  STATE_LEDGER,
} from '$lib/mls-client/stateLedgers';

/** Fingerprints kept per group. The busiest measured conversation held 2 073; this leaves 2.4x. */
export const MAX_FINGERPRINTS_PER_LEDGER = 5000;

/** Row keys kept per group. The busiest measured conversation held 2 762; this leaves 1.8x. */
export const MAX_ROW_KEYS_PER_LEDGER = 5000;

/** Ledgers kept per user. 169 were measured on the busiest bench profile; this leaves 1.5x. */
export const MAX_LEDGERS_PER_USER = 256;

/**
 * THE BYTES ONE LEDGER MAY TAKE, whatever its entries look like. The counts above do not bound
 * bytes: a row key of an id-less row embeds 64 characters of content the SERVER hands over, which
 * JSON may escape to six bytes each, so 5 000 of them alone passed 2 MB. 256 kB is three times the
 * busiest measured conversation (2 073 fingerprints and 2 762 row keys, about 75 kB), and a quarter
 * of {@link SEEN_LEDGERS_BYTE_BUDGET}, so a few busy conversations always fit together.
 */
export const MAX_BYTES_PER_LEDGER = 256 * 1024;

/**
 * The CBOR header of one text string in the state, at most: what each key and each value costs on top
 * of its own bytes.
 */
const CBOR_STRING_HEADER_BYTES = 5;

/**
 * What the seen ledgers and their index may take of {@link APP_LEDGERS_BYTE_BUDGET}. The rest is kept
 * for the ledgers this module does not bound - the send ledger's `persisted` counts (about 50 bytes
 * per group this device sent in, forgotten once their epoch is spent) and the format key.
 */
const SEEN_LEDGERS_BYTE_BUDGET = APP_LEDGERS_BYTE_BUDGET - 64 * 1024;

/** No character from 0x80 up: every one is a single UTF-8 byte, so the length IS the byte count. */
const NON_ASCII = /[-￿]/;

/**
 * UTF-8 length of `s`, without allocating: the unit the state is written in (a lone surrogate counts
 * as the three bytes of the replacement character an encoder writes for it).
 *
 * PURE ASCII IS ANSWERED BY THE ENGINE, NOT BY A LOOP. A ledger value is JSON, whose control
 * characters are escaped, so it is almost always ASCII, and the first checkpoint after a state opens
 * weighs every ledger once: 255 of 256 kB is 65 million characters through the per-character loop,
 * measured at 86 ms here and several times that on a phone. The native ASCII test is a single scan,
 * about five times cheaper; any other string still takes the exact loop.
 */
export function utf8Bytes(s: string): number {
  if (!NON_ASCII.test(s)) return s.length;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

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
  return boundLedgerBytes(all.filter((_, i) => keep[i]));
}

/**
 * Cuts a ledger to {@link MAX_BYTES_PER_LEDGER}, as its JSON array is written: ROW KEYS FIRST, then
 * fingerprints, oldest first in each.
 *
 * The order is the ledger's purpose. A lost row key costs one cheap re-check - the walk fetches the
 * row again, fingerprints it and finds it consumed. A lost fingerprint is the expensive mark: if the
 * walk ever re-reads that frame, MLS answers `SecretReuseError` and the client accuses it of being
 * lost. And the oldest of either is the least likely to be read again, because the walk resumes from
 * its stream cursor and only a frame ahead of it is ever re-read.
 */
function boundLedgerBytes(entries: string[]): string[] {
  const sizes = entries.map((e) => utf8Bytes(JSON.stringify(e)) + 1);
  let total = sizes.reduce((sum, n) => sum + n, 1);
  if (total <= MAX_BYTES_PER_LEDGER) return entries;
  const drop: boolean[] = Array.from({ length: entries.length }, () => false);
  let rowsDropped = 0;
  let fingerprintsDropped = 0;
  for (const fingerprints of [false, true]) {
    for (let i = 0; i < entries.length && total > MAX_BYTES_PER_LEDGER; i++) {
      if (isFingerprintEntry(entries[i]) !== fingerprints) continue;
      drop[i] = true;
      total -= sizes[i];
      if (fingerprints) fingerprintsDropped++;
      else rowsDropped++;
    }
  }
  // Said, and louder when a fingerprint went: that is the cut that can re-accuse a frame later.
  const line =
    `[HISTORY] a seen-ciphertext ledger passed ${MAX_BYTES_PER_LEDGER} bytes - ` +
    `${rowsDropped} oldest row key(s) and ${fingerprintsDropped} oldest fingerprint(s) dropped`;
  if (fingerprintsDropped > 0) console.warn(line);
  else console.log(line);
  return entries.filter((_, i) => !drop[i]);
}

/** The last measured weight of each ledger value, so a write does not re-measure the unchanged ones. */
const weighed = new Map<string, { value: string; bytes: number }>();

/** What one key and its value take in the state, read from the view. */
function weightInState(userId: string, key: string): number {
  const value = readStateLedger(userId, key);
  if (value === undefined) return 0;
  const cached = weighed.get(key);
  if (cached && cached.value === value) return cached.bytes;
  const bytes = utf8Bytes(key) + utf8Bytes(value) + 2 * CBOR_STRING_HEADER_BYTES;
  weighed.set(key, { value, bytes });
  return bytes;
}

/**
 * The ledgers to drop so the seen ledgers and their index fit {@link SEEN_LEDGERS_BYTE_BUDGET}: the
 * LEAST RECENTLY WRITTEN first, never `keep` (the one being written). Removes them from `index`.
 *
 * WHY WHOLE LEDGERS, AND WHY THE OLDEST WRITE. A ledger is written when its group consumes a frame,
 * so the least recently written one belongs to the conversation that has been quiet the longest. Its
 * walk resumes from its stream cursor, so what dropping it can cost is the frames this device consumed
 * there AFTER its last walk - an accusation if the walk re-reads one - and in the quietest group that
 * set is the smallest there is. Lowering the per-ledger caps instead would cut the BUSIEST
 * conversation, the one most likely to re-read a recent frame, on every profile, and would still not
 * bound a ledger's bytes. A budget four times the busiest measured profile (247 kB) means a real
 * profile evicts nothing.
 */
function evictOverByteBudget(userId: string, index: string[], keep: string): string[] {
  const indexEntryBytes = (g: string) => utf8Bytes(JSON.stringify(g)) + 1;
  let total = utf8Bytes(STATE_LEDGER.seenIndex) + 1 + 2 * CBOR_STRING_HEADER_BYTES;
  for (const g of index) total += weightInState(userId, STATE_LEDGER.seen(g)) + indexEntryBytes(g);
  const evicted: string[] = [];
  for (let i = 0; i < index.length && total > SEEN_LEDGERS_BYTE_BUDGET;) {
    const g = index[i];
    if (g === keep) {
      i++;
      continue;
    }
    total -= weightInState(userId, STATE_LEDGER.seen(g)) + indexEntryBytes(g);
    weighed.delete(STATE_LEDGER.seen(g));
    index.splice(i, 1);
    evicted.push(g);
  }
  if (evicted.length > 0) {
    console.warn(
      `[HISTORY] ${evicted.length} least recently written seen-ciphertext ledger(s) dropped, ` +
        `over the ${SEEN_LEDGERS_BYTE_BUDGET}-byte budget the MLS state gives them - their groups ` +
        `re-check their archive once`
    );
  }
  return evicted;
}

/**
 * The user's ledgers, oldest write first. The index the MLS state carries is the answer; when there
 * is none (a state whose ledgers came from a profile before this bound) the ledger keys are
 * enumerated once, in the order the state holds them.
 */
function readLedgerIndex(userId: string): string[] {
  const raw = readStateLedger(userId, STATE_LEDGER.seenIndex);
  if (raw !== undefined) {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((g): g is string => typeof g === 'string');
  }
  return stateLedgerKeys(userId, STATE_LEDGER.seenPrefix).map((key) =>
    key.slice(STATE_LEDGER.seenPrefix.length)
  );
}

/**
 * Records that `groupId`'s ledger was just staged, and returns the groups whose ledgers fell over
 * the per-user cap or the byte budget (least recently written first) so the caller can delete them. The group being
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
    if (evicted.length > 0) {
      console.warn(
        `[HISTORY] ${evicted.length} least recently written seen-ciphertext ledger(s) dropped, ` +
          `over the ${MAX_LEDGERS_PER_USER}-per-user cap - their groups re-walk their archive once`
      );
    }
    evicted.push(...evictOverByteBudget(userId, index, groupId));
    stageStateLedger(userId, STATE_LEDGER.seenIndex, JSON.stringify(index));
    return evicted;
  } catch (err) {
    console.warn(
      `[HISTORY] The seen-ledger index was not updated, no ledger evicted: ${String(err)}`
    );
    return [];
  }
}

/**
 * Brings the seen ledgers the view holds within {@link SEEN_LEDGERS_BYTE_BUDGET} when no ledger is
 * being written - after the `localStorage` migration staged copies no write had bounded. Drops the
 * least recently written first, as {@link noteLedgerWritten} does, and stages the removals.
 *
 * @returns the groups whose ledgers were dropped
 */
export function enforceSeenLedgerBudget(userId: string): string[] {
  try {
    const index = readLedgerIndex(userId);
    const evicted = evictOverByteBudget(userId, index, '');
    if (evicted.length === 0) return [];
    stageStateLedger(userId, STATE_LEDGER.seenIndex, JSON.stringify(index));
    for (const g of evicted) stageStateLedger(userId, STATE_LEDGER.seen(g), null);
    return evicted;
  } catch (err) {
    console.warn(
      `[HISTORY] The seen-ledger budget was not enforced, no ledger evicted: ${String(err)}`
    );
    return [];
  }
}
