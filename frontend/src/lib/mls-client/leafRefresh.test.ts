// @vitest-environment happy-dom
import type { Mock } from 'vitest';
import {
  LEAF_REFRESH_INTERVAL_MS,
  LEAF_REFRESH_LEDGER_MAX_GROUPS,
  decideLeafRefresh,
  holdLeafRefresh,
  leafRefreshHold,
  leafRefreshOffsetMs,
  noteLeafObserved,
  noteOwnLeafRefreshed,
  readLeafRefreshLedger,
  refreshLeafIfDue,
  type LeafRefreshDeps,
  type LeafRefreshRecord,
} from './leafRefresh';
import { CommitRefusedError } from './CommitRefusedError';
import { CommitOutcomeUnknownError, FollowerTabCommitError } from './commitSubmission';
import { UnpublishedBranchError } from './publishedBranch';

/**
 * THE PERIODIC LEAF REFRESH: WHEN A DEVICE REPLACES ITS OWN LEAF, AND EVERY CASE IN WHICH IT MUST NOT.
 *
 * The refresh is a commit, and commits are the failure class this product fights, so most of these
 * pin a REFUSAL: a key group (where each epoch move costs every sender a seed redistribution), a
 * group in an epoch gap (the recovery ladder owns it), a group this device was removed from, a leaf
 * that is young, and a second attempt at the epoch a first one failed at.
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

/** A leaf admitted eight days ago, as `own_leaf_minted_at` reads it. */
const OLD_MINT = (NOW - 8 * DAY) / 1000;

/**
 * Deps for a leaf admitted eight days ago and OBSERVED a full interval ago, so whatever its offset,
 * its first refresh is owed now - the state of every leaf one interval after this build shipped.
 */
function dueAdmitted(over: Partial<LeafRefreshDeps> = {}): LeafRefreshDeps {
  noteLeafObserved(U, D, G, 1, OLD_MINT, NOW - LEAF_REFRESH_INTERVAL_MS);
  return deps({ ownLeafMintedAt: async () => OLD_MINT, ...over });
}

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
  const OFFSET = 2 * DAY;
  const decide = (mintedAtSec: number | null, record: LeafRefreshRecord | undefined) =>
    decideLeafRefresh({ mintedAtSec, record, nowMs: NOW, offsetMs: OFFSET });
  const observed = (at: number, mintedAtSec: number | null): LeafRefreshRecord => ({
    at,
    epoch: 3,
    observed: true,
    mintedAtSec,
  });

  it('dates an admitted leaf by its KeyPackage once it has been observed', () => {
    expect(decide(OLD_MINT, observed(NOW - 3 * DAY, OLD_MINT))).toEqual({
      due: true,
      basis: 'admission',
      sinceMs: NOW - 8 * DAY,
      dueAtMs: NOW - DAY,
    });
  });

  it('owes an admitted leaf at the LATER of seven days old and its observation plus the offset', () => {
    // Day one: the leaf is 60 days old, but it was only seen now - its first refresh waits for
    // its offset, which is what spreads the seats of one group over the week.
    const ancient = (NOW - 60 * DAY) / 1000;
    expect(decide(ancient, observed(NOW - DAY, ancient))).toMatchObject({
      due: false,
      dueAtMs: NOW + DAY,
    });
    // A young leaf: its own seven days decide, whatever the observation says.
    const young = (NOW - 2 * DAY) / 1000;
    expect(decide(young, observed(NOW - 2 * DAY, young))).toMatchObject({
      due: false,
      dueAtMs: NOW + 5 * DAY,
    });
  });

  it('reads an admitted leaf with no observation OF IT as a first sight, whatever else is there', () => {
    // A ledger REFRESH is written only after OUR OWN commit, which leaves a commit-sourced leaf: a
    // leaf still dated by a KeyPackage is a NEWER incarnation (a Welcome after a forget). An
    // observation of another incarnation describes a leaf that no longer exists either.
    for (const record of [
      undefined,
      { at: NOW - DAY, epoch: 3 },
      observed(NOW - 3 * DAY, OLD_MINT - 1),
      observed(NOW - 3 * DAY, null),
    ]) {
      expect(decide(OLD_MINT, record)).toEqual({
        due: false,
        basis: 'first-sight',
        sinceMs: NOW,
        dueAtMs: null,
      });
    }
  });

  it('dates a refreshed leaf by the ledger, seven days after the refresh, with no offset', () => {
    expect(decide(null, { at: NOW - 6 * DAY, epoch: 3 })).toEqual({
      due: false,
      basis: 'ledger',
      sinceMs: NOW - 6 * DAY,
      dueAtMs: NOW + DAY,
    });
    expect(decide(null, { at: NOW - 7 * DAY, epoch: 3 }).due).toBe(true);
  });

  it('owes an observed commit-sourced leaf at the observation plus the offset', () => {
    expect(decide(null, observed(NOW - DAY, null))).toMatchObject({
      due: false,
      basis: 'observed',
      dueAtMs: NOW + DAY,
    });
    expect(decide(null, observed(NOW - 2 * DAY, null)).due).toBe(true);
  });

  it('is never due on first sight of a leaf it has no date for', () => {
    // A lost ledger must not turn every group into a commit at the next send.
    expect(decide(null, undefined)).toEqual({
      due: false,
      basis: 'first-sight',
      sinceMs: NOW,
      dueAtMs: null,
    });
  });

  it('does not believe a ledger date in the future - the leaf is observed again', () => {
    // Written by a clock that was ahead: believed, it would postpone the refresh by however far
    // ahead that clock was, instead of by at most one interval.
    expect(decide(null, { at: NOW + 300 * DAY, epoch: 3 }).basis).toBe('first-sight');
    expect(decide(OLD_MINT, observed(NOW + DAY, OLD_MINT)).basis).toBe('first-sight');
  });

  it('is not due when the clock went backwards past the admission', () => {
    const future = (NOW + DAY) / 1000;
    expect(decide(future, observed(NOW - 7 * DAY, future)).due).toBe(false);
  });

  it('uses a seven-day interval', () => {
    expect(LEAF_REFRESH_INTERVAL_MS).toBe(7 * DAY);
  });
});

describe('leafRefreshOffsetMs - the first refresh spread, deterministically', () => {
  it('is a pure function of (device, group), inside the interval', () => {
    const a = leafRefreshOffsetMs('web-a', 'g-1');
    expect(leafRefreshOffsetMs('web-a', 'g-1')).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(LEAF_REFRESH_INTERVAL_MS);
    // Another device in the same group, or the same device in another group, lands elsewhere.
    expect(leafRefreshOffsetMs('web-b', 'g-1')).not.toBe(a);
    expect(leafRefreshOffsetMs('web-a', 'g-2')).not.toBe(a);
  });

  it('spreads the seats evenly over the seven days, ids with a trailing counter included', () => {
    // 7000 seats: 1000 per day expected. The ids differ only in a trailing counter - the shape
    // that left an unmixed FNV-1a's high bits in 5 of 16 slices.
    const perDay = Array.from({ length: 7 }, () => 0);
    for (let device = 0; device < 70; device++) {
      for (let group = 0; group < 100; group++) {
        perDay[Math.floor(leafRefreshOffsetMs(`tauri-dev-${device}`, `group-${group}`) / DAY)]++;
      }
    }
    for (const count of perDay) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });

  it('turns day one in a 109-seat group into about one refresh in seven per day, not a herd', () => {
    // Every leaf admitted 60 days ago, every seat observed at its first send on day one, every
    // seat sending daily after it: the day each one's first refresh falls on.
    const minted = (NOW - 60 * DAY) / 1000;
    const perDay = Array.from({ length: 8 }, () => 0);
    for (let seat = 0; seat < 109; seat++) {
      const offsetMs = leafRefreshOffsetMs(`device-${seat}`, 'group-109');
      const record: LeafRefreshRecord = { at: NOW, epoch: 1, observed: true, mintedAtSec: minted };
      const day = [1, 2, 3, 4, 5, 6, 7, 8].find(
        (d) =>
          decideLeafRefresh({ mintedAtSec: minted, record, nowMs: NOW + d * DAY, offsetMs }).due
      );
      perDay[(day ?? 0) - 1]++;
    }
    // ~15.6 a day expected; with no spread all 109 were due on day one.
    expect(Math.max(...perDay)).toBeLessThanOrEqual(30);
    expect(perDay.reduce((a, b) => a + b, 0)).toBe(109);
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
    const outcome = await refreshLeafIfDue(dueAdmitted(), G);

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
    expect(readLeafRefreshLedger(U, D)[G]).toEqual({
      at: NOW,
      epoch: 7,
      observed: true,
      mintedAtSec: null,
    });
  });

  it('observes an old admitted leaf at its first send, and refreshes it only from its offset on', async () => {
    // The herd this exists for: a leaf 60 days old is NOT refreshed at the first send after the
    // build ships, but at the first send after its (device, group) offset has passed.
    const minted = (NOW - 60 * DAY) / 1000;
    const offset = leafRefreshOffsetMs(D, G);
    let clock = NOW;
    const d = deps({ ownLeafMintedAt: async () => minted, now: () => clock });

    expect(await refreshLeafIfDue(d, G)).toBe('first-sight');
    expect(readLeafRefreshLedger(U, D)[G]).toMatchObject({ observed: true, mintedAtSec: minted });

    clock = NOW + offset - 1;
    expect(await refreshLeafIfDue(d, G)).toBe('not-due');
    clock = NOW + offset;
    expect(await refreshLeafIfDue(d, G)).toBe('refreshed');
    expect(refreshOwnLeaf).toHaveBeenCalledTimes(1);
  });

  it('never refreshes a key group - each epoch move there costs every sender a re-distribution', async () => {
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
    const outcome = await refreshLeafIfDue(dueAdmitted({ isInEpochGap: () => true }), G);
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
    const d = dueAdmitted();

    expect(await refreshLeafIfDue(d, G)).toBe('failed');
    // Still only the observation: no refresh is recorded.
    expect(readLeafRefreshLedger(U, D)[G]).toMatchObject({ observed: true });
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

  it('reports a refresh whose outcome is UNKNOWN as unresolved, dating nothing', async () => {
    refreshOwnLeaf.mockRejectedValue(new CommitOutcomeUnknownError(G, 7, 'offline'));
    const d = dueAdmitted();
    expect(await refreshLeafIfDue(d, G)).toBe('unresolved');
    expect(readLeafRefreshLedger(U, D)[G]).toMatchObject({ observed: true });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('UNKNOWN outcome');
  });

  it('is held while something in the group needs the epoch to stay put (a call being set up)', async () => {
    // A call derives its media keys from the group's CURRENT epoch on each end, one after the
    // other: a refresh between the two derivations gives the two ends different keys.
    const release = holdLeafRefresh(G, 'call');
    const d = dueAdmitted();
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
    refreshOwnLeaf.mockRejectedValue(new UnpublishedBranchError(G, 'diverged', 'leaf refresh'));
    const d = dueAdmitted();

    expect(await refreshLeafIfDue(d, G)).toBe('unverified');
    expect(lines.join(' | ')).toContain('diverged');
    expect(readLeafRefreshLedger(U, D)[G]).toMatchObject({ observed: true });
    expect(await refreshLeafIfDue(d, G)).toBe('already-tried');
    expect(refreshOwnLeaf).toHaveBeenCalledTimes(1);
  });

  it('a follower tab is not a failure: no FAILED line, and not asked again at the same epoch', async () => {
    refreshOwnLeaf.mockRejectedValue(new FollowerTabCommitError(G));
    const d = dueAdmitted();

    expect(await refreshLeafIfDue(d, G)).toBe('follower-tab');
    expect(lines.join(' | ')).not.toContain('FAILED');
    expect(readLeafRefreshLedger(U, D)[G]).toMatchObject({ observed: true });
    expect(await refreshLeafIfDue(d, G)).toBe('already-tried');
    expect(refreshOwnLeaf).toHaveBeenCalledTimes(1);
  });
});
