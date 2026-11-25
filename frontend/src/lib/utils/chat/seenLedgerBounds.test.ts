// @vitest-environment happy-dom
/**
 * The two bounds on the durable seen-ciphertext ledger: one cap per namespace, and a cap on the
 * number of ledgers. Eviction order is asserted, because "the oldest goes first" is the whole
 * point - the old shared cap evicted the FINGERPRINTS (the marks whose loss accuses a frame) first.
 */
vi.mock('$lib/utils/chat/historyReconcile', () => ({
  escalateReconciliation: vi.fn().mockResolvedValue(true),
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  boundSeenEntries,
  enforceSeenLedgerBudget,
  isFingerprintEntry,
  MAX_BYTES_PER_LEDGER,
  MAX_FINGERPRINTS_PER_LEDGER,
  MAX_LEDGERS_PER_USER,
  MAX_ROW_KEYS_PER_LEDGER,
  utf8Bytes,
} from './seenLedgerBounds';
import {
  makeRoomToKeepFrame,
  markHistoryFrameConsumed,
  resetSeenCipherCacheForTests,
  stagePendingHistoryMarks,
} from './history';
import {
  APP_LEDGERS_BYTE_BUDGET,
  hydrateStateLedgers,
  readStateLedger,
  resetStateLedgersForTests,
  STATE_LEDGER,
  takeStagedStateLedgers,
} from '$lib/mls-client/stateLedgers';
import {
  KEPT_FRAME_MAX_BYTES,
  KEPT_FRAMES_BYTE_BUDGET,
  keptFrameKey,
  keptFrameNeeds,
  keptFrameValue,
} from '$lib/mls-client/keptKeyGroupFrames';

const USER = 'user-bounds';

/** The ledgers the MLS state on disk carries. */
let disk: Map<string, string>;

const persisted = (group: string): string[] | null => {
  const raw = disk.get(STATE_LEDGER.seen(group));
  return raw === undefined ? null : JSON.parse(raw);
};
/** Every seen ledger the state on disk carries. */
const ledgersOnDisk = () => [...disk.keys()].filter((k) => k.startsWith(STATE_LEDGER.seenPrefix));

/** A checkpoint whose write lands at once - the only thing that makes a mark durable. */
const checkpoint = () => {
  stagePendingHistoryMarks(USER);
  for (const [k, v] of Object.entries(takeStagedStateLedgers(USER) ?? {})) {
    if (v === null) disk.delete(k);
    else disk.set(k, v);
  }
};

const fp = (n: number) => `${n.toString(36)}:${(n * 7919).toString(36)}`;
const row = (n: number) => `${1786655250000 + n}-0`;

beforeEach(() => {
  disk = new Map();
  resetSeenCipherCacheForTests();
  resetStateLedgersForTests();
  hydrateStateLedgers(USER, {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('namespaces', () => {
  it('tells a fingerprint from a stream id and from the id-less fallback key', () => {
    expect(isFingerprintEntry('5:abc12')).toBe(true);
    expect(isFingerprintEntry('1786655250946-0')).toBe(false);
    expect(isFingerprintEntry('2026-10-08T10:00:00.000Z:AAAA/bbb==')).toBe(false);
  });
});

describe('per-namespace caps', () => {
  it('keeps every fingerprint when row keys alone overflow the old shared 5 000', () => {
    // The measured shape: row keys outnumber fingerprints and, in one array, evicted them.
    const entries: string[] = [];
    for (let i = 0; i < 2073; i++) entries.push(fp(i));
    for (let i = 0; i < 6000; i++) entries.push(row(i));
    const bounded = boundSeenEntries(entries);
    expect(bounded.filter(isFingerprintEntry)).toHaveLength(2073);
    expect(bounded.filter((e) => !isFingerprintEntry(e))).toHaveLength(MAX_ROW_KEYS_PER_LEDGER);
  });

  it('evicts the OLDEST of the overflowing namespace and preserves order', () => {
    const entries: string[] = [];
    for (let i = 0; i < MAX_FINGERPRINTS_PER_LEDGER + 3; i++) {
      entries.push(fp(i));
      entries.push(row(i));
    }
    const bounded = boundSeenEntries(entries);
    const fps = bounded.filter(isFingerprintEntry);
    expect(fps).toHaveLength(MAX_FINGERPRINTS_PER_LEDGER);
    expect(fps[0]).toBe(fp(3));
    expect(fps.at(-1)).toBe(fp(MAX_FINGERPRINTS_PER_LEDGER + 2));
    const rows = bounded.filter((e) => !isFingerprintEntry(e));
    expect(rows[0]).toBe(row(3));
    // Interleaving survives: the cut never reorders what it keeps.
    expect(bounded.slice(0, 2)).toEqual([fp(3), row(3)]);
  });

  it('writes the bounded ledger durably', () => {
    for (let i = 0; i < MAX_FINGERPRINTS_PER_LEDGER + 2; i++)
      markHistoryFrameConsumed(USER, 'g', fp(i));
    checkpoint();
    const stored = persisted('g') ?? [];
    expect(stored).toHaveLength(MAX_FINGERPRINTS_PER_LEDGER);
    expect(stored[0]).toBe(fp(2));
  });
});

describe('ledgers per user', () => {
  it('drops the least recently WRITTEN ledger once the cap is passed, and only it', () => {
    for (let g = 0; g < MAX_LEDGERS_PER_USER; g++) {
      markHistoryFrameConsumed(USER, `g${g}`, fp(g));
      checkpoint();
    }
    expect(persisted('g0')).not.toBeNull();
    // Rewriting g0 makes it the most recent, so g1 becomes the oldest.
    markHistoryFrameConsumed(USER, 'g0', fp(9999));
    checkpoint();
    markHistoryFrameConsumed(USER, 'overflow', fp(1));
    checkpoint();
    expect(persisted('g1')).toBeNull();
    expect(persisted('g0')).not.toBeNull();
    expect(persisted('g2')).not.toBeNull();
    expect(persisted('overflow')).not.toBeNull();
    expect(ledgersOnDisk()).toHaveLength(MAX_LEDGERS_PER_USER);
  });

  it('adopts ledgers written before the index existed', () => {
    const old: Record<string, string> = {};
    for (let g = 0; g < MAX_LEDGERS_PER_USER; g++) {
      old[STATE_LEDGER.seen(`old${g}`)] = JSON.stringify([fp(g)]);
    }
    for (const [k, v] of Object.entries(old)) disk.set(k, v);
    hydrateStateLedgers(USER, old);
    markHistoryFrameConsumed(USER, 'fresh', fp(1));
    checkpoint();
    expect(persisted('fresh')).not.toBeNull();
    expect(ledgersOnDisk()).toHaveLength(MAX_LEDGERS_PER_USER);
  });

  it("never counts another user's ledgers", () => {
    hydrateStateLedgers('someone-else', { [STATE_LEDGER.seen('g')]: JSON.stringify([fp(1)]) });
    for (let g = 0; g < MAX_LEDGERS_PER_USER + 1; g++) {
      markHistoryFrameConsumed(USER, `g${g}`, fp(g));
      checkpoint();
    }
    expect(readStateLedger('someone-else', STATE_LEDGER.seen('g'))).toBeDefined();
    expect(takeStagedStateLedgers('someone-else')).toBeUndefined();
  });
});

describe('the byte budget of every ledger the MLS state carries', () => {
  /** The ceiling the review of #2515 set: every checkpoint seals and writes all of it. */
  const BUDGET = APP_LEDGERS_BYTE_BUDGET;
  const encoder = new TextEncoder();
  const utf8 = (s: string) => encoder.encode(s).length;
  /** As CBOR stores the map: each key and value raw, behind a text-string header of at most 5 bytes. */
  const cborBytes = (m: Map<string, string>) => {
    let n = 9;
    for (const [k, v] of m) n += utf8(k) + utf8(v) + 10;
    return n;
  };
  /** A checkpoint that writes whatever is staged, removals included. */
  const land = () => {
    for (const [k, v] of Object.entries(takeStagedStateLedgers(USER) ?? {})) {
      if (v === null) disk.delete(k);
      else disk.set(k, v);
    }
  };

  // THE LONGEST SHAPE EACH ENTRY MAY TAKE. A fingerprint is `<len36>:<hash36>`, 8 + 1 + 8. A row key
  // is a stream id, or for an id-less row `<timestamp>:<first 64 chars of the content>` - content the
  // SERVER hands over, so 64 control characters, which JSON escapes to six bytes each.
  const CONTROL = String.fromCharCode(1);
  const longFp = (n: number) =>
    `${n.toString(36).padStart(8, 'z')}:${(n * 7919).toString(36).padStart(8, 'y')}`;
  const longRow = (n: number) =>
    `2026-11-15T10:00:00.000Z:${CONTROL.repeat(60)}${n.toString(36).padStart(4, '0')}`;
  const groupId = (g: number) => `${'g'.repeat(76)}${g.toString().padStart(4, '0')}`;
  const fullLedger = (): string[] => {
    const entries: string[] = [];
    for (let i = 0; i < MAX_FINGERPRINTS_PER_LEDGER; i++) entries.push(longFp(i), longRow(i));
    return entries;
  };

  it('holds at most the budget once every ledger is full of its longest entries', () => {
    // A state opened with every ledger but one at its caps (the value is one shared string, so the
    // test holds it once), the send counts of as many groups, and the format key. At its caps means
    // bounded as every write of this build bounds it: unbounded, each copy is 2 MB, and weighing 255
    // of them timed the case out on a loaded CI runner while testing nothing a state can hold.
    const full = JSON.stringify(boundSeenEntries(fullLedger()));
    const opened: Record<string, string> = {};
    const index: string[] = [];
    for (let g = 0; g < MAX_LEDGERS_PER_USER - 1; g++) {
      opened[STATE_LEDGER.seen(groupId(g))] = full;
      index.push(groupId(g));
    }
    opened[STATE_LEDGER.seenIndex] = JSON.stringify(index);
    const persistedCounts: Record<string, number> = {};
    for (let g = 0; g < MAX_LEDGERS_PER_USER; g++) persistedCounts[`${groupId(g)}@123456`] = 99999;
    opened[STATE_LEDGER.sendPersisted] = JSON.stringify(persistedCounts);
    opened[STATE_LEDGER.format] = '1';
    hydrateStateLedgers(USER, opened);
    disk = new Map(Object.entries(opened));

    // The last ledger is written by the app, to its caps.
    const last = groupId(MAX_LEDGERS_PER_USER - 1);
    for (const entry of fullLedger()) markHistoryFrameConsumed(USER, last, entry);
    checkpoint();

    expect(cborBytes(disk)).toBeLessThanOrEqual(BUDGET);
    // The ledger just written is never the one dropped, and keeps its newest fingerprints.
    const written = persisted(last) ?? [];
    expect(written).toContain(longFp(MAX_FINGERPRINTS_PER_LEDGER - 1));
    // What went is the least recently written, oldest first.
    expect(persisted(groupId(0))).toBeNull();
  });

  it('cuts an over-heavy ledger by its oldest ROW KEYS first, and keeps every fingerprint', () => {
    const bounded = boundSeenEntries(fullLedger());
    expect(utf8(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_BYTES_PER_LEDGER);
    expect(bounded.filter(isFingerprintEntry)).toHaveLength(MAX_FINGERPRINTS_PER_LEDGER);
    const rows = bounded.filter((e) => !isFingerprintEntry(e));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)).toBe(longRow(MAX_FINGERPRINTS_PER_LEDGER - 1));
    expect(rows).not.toContain(longRow(0));
  });

  it('keeps a ledger of fingerprints alone whole: 5 000 of the longest fit the cap', () => {
    const onlyFps = Array.from({ length: MAX_FINGERPRINTS_PER_LEDGER }, (_, i) => longFp(i));
    expect(boundSeenEntries(onlyFps)).toEqual(onlyFps);
  });

  it('brings the ledgers an older client left within the budget, with no ledger being written', () => {
    const full = JSON.stringify(fullLedger());
    const opened: Record<string, string> = {};
    const index: string[] = [];
    for (let g = 0; g < 20; g++) {
      opened[STATE_LEDGER.seen(groupId(g))] = full;
      index.push(groupId(g));
    }
    opened[STATE_LEDGER.seenIndex] = JSON.stringify(index);
    hydrateStateLedgers(USER, opened);
    disk = new Map(Object.entries(opened));
    const evicted = enforceSeenLedgerBudget(USER);
    land();
    expect(evicted[0]).toBe(groupId(0));
    expect(cborBytes(disk)).toBeLessThanOrEqual(BUDGET);
  });

  it('gives way to the key-group frames kept until handled, and to the one about to be kept', () => {
    // Seen ledgers that fit the whole budget on their own (mls-desync-prevention section 11).
    const full = JSON.stringify(boundSeenEntries(fullLedger()));
    const opened: Record<string, string> = {};
    const index: string[] = [];
    for (let g = 0; g < 4; g++) {
      opened[STATE_LEDGER.seen(groupId(g))] = full;
      index.push(groupId(g));
    }
    opened[STATE_LEDGER.seenIndex] = JSON.stringify(index);
    // One group keeps a frame of a whole share, as a handler failing for good leaves it.
    const plaintext = new Uint8Array(Math.floor(((KEPT_FRAME_MAX_BYTES - 1024) * 3) / 4));
    opened[keptFrameKey('g-a', '1:a')] = keptFrameValue('p:d', plaintext);
    hydrateStateLedgers(USER, opened);
    disk = new Map(Object.entries(opened));

    // A second group's largest frame is about to be decrypted and kept: room is made BEFORE it.
    const needs = keptFrameNeeds(plaintext.length);
    expect(needs).toBeLessThanOrEqual(KEPT_FRAMES_BYTE_BUDGET - KEPT_FRAME_MAX_BYTES);
    makeRoomToKeepFrame(USER, needs);
    land();

    expect(cborBytes(disk) + needs).toBeLessThanOrEqual(BUDGET);
    // The least recently written seen ledger went; the kept frame did not.
    expect(disk.has(STATE_LEDGER.seen(groupId(0)))).toBe(false);
    expect(disk.has(keptFrameKey('g-a', '1:a'))).toBe(true);
  });

  it('counts bytes as an encoder writes them', () => {
    const samples = ['abc', 'é', '€', String.fromCodePoint(0x1f600), CONTROL];
    samples.push(String.fromCharCode(0xd800) + 'x');
    for (const s of samples) expect(utf8Bytes(s)).toBe(utf8(s));
  });

  it('holds the same budget as the ERROR witness of mls-core', () => {
    const rust = readFileSync(resolve(process.cwd(), 'mls-core/src/app_ledgers.rs'), 'utf8');
    const declared = /pub const APP_LEDGERS_BYTE_BUDGET: usize = ([0-9_]+);/.exec(rust)?.[1];
    expect(Number(declared?.replaceAll('_', ''))).toBe(BUDGET);
  });
});
