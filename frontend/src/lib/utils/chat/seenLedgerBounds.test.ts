// @vitest-environment happy-dom
/**
 * The two bounds on the durable seen-ciphertext ledger: one cap per namespace, and a cap on the
 * number of ledgers. Eviction order is asserted, because "the oldest goes first" is the whole
 * point - the old shared cap evicted the FINGERPRINTS (the marks whose loss accuses a frame) first.
 */
vi.mock('$lib/utils/chat/historyReconcile', () => ({
  escalateReconciliation: vi.fn().mockResolvedValue(true),
}));

import {
  boundSeenEntries,
  isFingerprintEntry,
  MAX_FINGERPRINTS_PER_LEDGER,
  MAX_LEDGERS_PER_USER,
  MAX_ROW_KEYS_PER_LEDGER,
} from './seenLedgerBounds';
import {
  markHistoryFrameConsumed,
  resetSeenCipherCacheForTests,
  stagePendingHistoryMarks,
} from './history';
import {
  hydrateStateLedgers,
  readStateLedger,
  resetStateLedgersForTests,
  STATE_LEDGER,
  takeStagedStateLedgers,
} from '$lib/mls-client/stateLedgers';

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
