import type { Mock } from 'vitest';
import {
  LEAF_REFRESH_INTERVAL_MS,
  LEAF_REFRESH_LEDGER_MAX_GROUPS,
  LeafRefreshUnverifiedError,
  decideLeafRefresh,
  holdLeafRefresh,
  leafRefreshHold,
  noteOwnLeafRefreshed,
  readLeafRefreshLedger,
  refreshLeafIfDue,
  type LeafRefreshDeps,
} from './leafRefresh';
import { CommitRefusedError } from './CommitRefusedError';

/**
 * THE PERIODIC LEAF REFRESH: WHEN A DEVICE REPLACES ITS OWN LEAF, AND EVERY CASE IN WHICH IT MUST NOT.
 *
 * The refresh is a commit, and commits are the failure class this product fights, so most of these
 * pin a REFUSAL: a key group (where an epoch move rotates every sender's seed), a group in an epoch
 * gap (the recovery ladder owns it), a group this device was removed from, a leaf that is young, and
 * a second attempt at the epoch a first one failed at.
 */

const U = 'user-a';
const D = 'web-a';
const G = 'g-1';
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let lines: string[];
let refreshOwnLeaf: Mock<(groupId: string) => Promise<void>>;
let checkpoint: Mock<() => Promise<boolean>>;
let attempts: Map<string, number>;
let epoch: number;

function deps(over: Partial<LeafRefreshDeps> = {}): LeafRefreshDeps {
  return {
    userId: U,
    deviceId: D,
    isDistributionGroup: () => false,
    isInEpochGap: () => false,
    isGroupActive: async () => true,
    getEpoch: () => epoch,
    ownLeafMintedAt: async () => null,
    refreshOwnLeaf,
    checkpoint,
    attemptedAtEpoch: attempts,
    now: () => NOW,
    log: (m) => lines.push(m),
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  lines = [];
  epoch = 7;
  attempts = new Map();
  checkpoint = vi.fn().mockResolvedValue(true);
  refreshOwnLeaf = vi.fn(async (groupId: string) => {
    // What `runCommitTransaction` does on the accepted path: the epoch moves and the ledger is told.
    epoch += 1;
    noteOwnLeafRefreshed(U, D, groupId, epoch, NOW);
  });
});

describe('decideLeafRefresh - how old the leaf is, read from the tree first', () => {
  it('dates an admitted leaf by its KeyPackage, whatever the ledger says', () => {
    // A ledger entry is written only after OUR OWN commit, which leaves a commit-sourced leaf. A
    // leaf still dated by a KeyPackage is therefore a NEWER incarnation (a Welcome after a forget):
    // the entry describes a leaf that no longer exists.
    const d = decideLeafRefresh({
      mintedAtSec: (NOW - 8 * DAY) / 1000,
      record: { at: NOW - DAY, epoch: 3 },
      nowMs: NOW,
    });
    expect(d).toEqual({ due: true, basis: 'admission', sinceMs: NOW - 8 * DAY });
  });

  it('dates a refreshed leaf by the ledger', () => {
    expect(
      decideLeafRefresh({ mintedAtSec: null, record: { at: NOW - 6 * DAY, epoch: 3 }, nowMs: NOW })
    ).toEqual({ due: false, basis: 'ledger', sinceMs: NOW - 6 * DAY });
    expect(
      decideLeafRefresh({ mintedAtSec: null, record: { at: NOW - 7 * DAY, epoch: 3 }, nowMs: NOW })
        .due
    ).toBe(true);
  });

  it('is never due on first sight of a refreshed leaf it has no date for', () => {
    // A lost ledger must not turn every group into a commit at the next send.
    expect(decideLeafRefresh({ mintedAtSec: null, record: undefined, nowMs: NOW })).toEqual({
      due: false,
      basis: 'first-sight',
      sinceMs: NOW,
    });
  });

  it('is not due when the clock went backwards', () => {
    expect(
      decideLeafRefresh({ mintedAtSec: (NOW + DAY) / 1000, record: undefined, nowMs: NOW }).due
    ).toBe(false);
  });

  it('uses a seven-day interval', () => {
    expect(LEAF_REFRESH_INTERVAL_MS).toBe(7 * DAY);
  });
});

describe('the ledger - one map per account AND device', () => {
  it('keeps devices and accounts apart', () => {
    noteOwnLeafRefreshed(U, D, G, 4, NOW);
    expect(readLeafRefreshLedger(U, D)[G]).toEqual({ at: NOW, epoch: 4 });
    expect(readLeafRefreshLedger(U, 'other-device')).toEqual({});
    expect(readLeafRefreshLedger('user-b', D)).toEqual({});
  });

  it('is bounded: the oldest entries go first', () => {
    for (let i = 0; i < LEAF_REFRESH_LEDGER_MAX_GROUPS + 3; i++) {
      noteOwnLeafRefreshed(U, D, `g-${i}`, 1, NOW + i);
    }
    const ledger = readLeafRefreshLedger(U, D);
    expect(Object.keys(ledger)).toHaveLength(LEAF_REFRESH_LEDGER_MAX_GROUPS);
    expect(ledger['g-0']).toBeUndefined();
    expect(ledger[`g-${LEAF_REFRESH_LEDGER_MAX_GROUPS + 2}`]).toBeDefined();
  });

  it('reads an unreadable ledger as empty, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(`mls_leaf_refresh:${U}:${D}`, '{not json');
    expect(readLeafRefreshLedger(U, D)).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('refreshLeafIfDue', () => {
  it('refreshes a leaf admitted more than seven days ago, then checkpoints', async () => {
    const outcome = await refreshLeafIfDue(
      deps({ ownLeafMintedAt: async () => (NOW - 8 * DAY) / 1000 }),
      G
    );

    expect(outcome).toBe('refreshed');
    expect(refreshOwnLeaf).toHaveBeenCalledExactlyOnceWith(G);
    // Awaited, not scheduled: the server holds the new epoch, and the secrets of our new leaf exist
    // only in memory until this lands.
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(readLeafRefreshLedger(U, D)[G]).toEqual({ at: NOW, epoch: 8 });
    expect(lines.join(' | ')).toContain('[LEAF_REFRESH]');
  });

  it('does nothing for a young leaf', async () => {
    noteOwnLeafRefreshed(U, D, G, 7, NOW - 2 * DAY);
    expect(await refreshLeafIfDue(deps(), G)).toBe('not-due');
    expect(refreshOwnLeaf).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('records a first sight instead of committing', async () => {
    expect(await refreshLeafIfDue(deps(), G)).toBe('first-sight');
    expect(refreshOwnLeaf).not.toHaveBeenCalled();
    expect(readLeafRefreshLedger(U, D)[G]).toEqual({ at: NOW, epoch: 7 });
  });

  it('never refreshes a key group - an epoch move there rotates every sender seed', async () => {
    const outcome = await refreshLeafIfDue(
      deps({
        isDistributionGroup: () => true,
        ownLeafMintedAt: async () => (NOW - 30 * DAY) / 1000,
      }),
      G
    );
    expect(outcome).toBe('key-group');
    expect(refreshOwnLeaf).not.toHaveBeenCalled();
  });

  it('leaves a group in an epoch gap to the recovery ladder', async () => {
    const outcome = await refreshLeafIfDue(
      deps({ isInEpochGap: () => true, ownLeafMintedAt: async () => (NOW - 30 * DAY) / 1000 }),
      G
    );
    expect(outcome).toBe('epoch-gap');
    expect(refreshOwnLeaf).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('epoch gap');
  });

  it('does nothing in a group this device is no longer a member of', async () => {
    const outcome = await refreshLeafIfDue(
      deps({ isGroupActive: async () => false, ownLeafMintedAt: async () => 1 }),
      G
    );
    expect(outcome).toBe('inactive');
    expect(refreshOwnLeaf).not.toHaveBeenCalled();
  });

  it('records nothing when the commit is refused, and does not retry at the same epoch', async () => {
    refreshOwnLeaf.mockRejectedValue(new CommitRefusedError('epoch_mismatch', 7, 8));
    const d = deps({ ownLeafMintedAt: async () => (NOW - 8 * DAY) / 1000 });

    expect(await refreshLeafIfDue(d, G)).toBe('failed');
    expect(readLeafRefreshLedger(U, D)[G]).toBeUndefined();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('refused');

    // The next send at the SAME epoch would face the same answer: not asked again...
    expect(await refreshLeafIfDue(d, G)).toBe('already-tried');
    expect(refreshOwnLeaf).toHaveBeenCalledTimes(1);

    // ...until the epoch moves, which is the event that makes a retry different.
    epoch = 8;
    refreshOwnLeaf.mockResolvedValue(undefined);
    expect(await refreshLeafIfDue(d, G)).toBe('refreshed');
    expect(refreshOwnLeaf).toHaveBeenCalledTimes(2);
  });

  it('is held while something in the group needs the epoch to stay put (a call being set up)', async () => {
    // A call derives its media keys from the group's CURRENT epoch on each end, one after the
    // other: a refresh between the two derivations gives the two ends different keys.
    const release = holdLeafRefresh(G, 'call');
    const d = deps({ ownLeafMintedAt: async () => (NOW - 8 * DAY) / 1000 });
    expect(await refreshLeafIfDue(d, G)).toBe('held');
    expect(refreshOwnLeaf).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('call');

    // Another group is not held, and the release lifts the hold.
    expect(leafRefreshHold('g-other')).toBeNull();
    release();
    expect(leafRefreshHold(G)).toBeNull();
    expect(await refreshLeafIfDue(d, G)).toBe('refreshed');
  });

  it('a release is idempotent and lifts only its own hold', () => {
    const a = holdLeafRefresh(G, 'call');
    const b = holdLeafRefresh(G, 'call');
    a();
    a();
    expect(leafRefreshHold(G)).toBe('call');
    b();
    expect(leafRefreshHold(G)).toBeNull();
  });

  it('a refresh the published base could not vouch for is not retried at the same epoch', async () => {
    refreshOwnLeaf.mockRejectedValue(new LeafRefreshUnverifiedError(G, 'diverged'));
    const d = deps({ ownLeafMintedAt: async () => (NOW - 8 * DAY) / 1000 });

    expect(await refreshLeafIfDue(d, G)).toBe('unverified');
    expect(lines.join(' | ')).toContain('diverged');
    expect(readLeafRefreshLedger(U, D)[G]).toBeUndefined();
    expect(await refreshLeafIfDue(d, G)).toBe('already-tried');
    expect(refreshOwnLeaf).toHaveBeenCalledTimes(1);
  });
});
