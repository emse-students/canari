import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { IMlsService } from '$lib/mlsService';
import { withoutAnyComments } from '$lib/styles/markupSources';
import { forgetGroupsAbsentFromServer, readGroupSweepSnapshot } from './groupSweep';

/**
 * Minimal service stub. `getGroupServerStatus` answers with a LIVE row naming no distribution
 * scope, which `decideAbsentLocalGroupFate` reduces to `forget` - the destructive branch, so a test
 * that expects nothing forgotten is measuring the guard rather than a stub that had nothing to do.
 */
function makeMls(overrides: Partial<Record<string, unknown>> = {}): IMlsService {
  const built: Record<string, unknown> = {
    getUserGroups: vi.fn().mockResolvedValue([]),
    getLocalGroups: vi.fn().mockReturnValue([]),
    getGroupServerStatus: vi.fn().mockResolvedValue({ groupId: 'x', deletedAt: null }),
    isDistributionGroup: vi.fn().mockReturnValue(false),
    registerDistributionGroup: vi.fn(),
    noteDistributionGroup: vi.fn(),
    forgetGroup: vi.fn(),
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    forgetDistributionGroupById: vi.fn(async (groupId: string) => {
      const local = (built.getLocalGroups as () => string[])();
      if (!local.includes(groupId)) return false;
      (built.forgetGroup as (id: string, minEpoch: number) => void)(groupId, 0);
      return true;
    }),
    ...overrides,
  };
  return built as unknown as IMlsService;
}

describe('readGroupSweepSnapshot', () => {
  it('captures the local set BEFORE the fetch, so a group born during it is spared', async () => {
    // The 2026-08-30 measurement, as a test: a group created while `getUserGroups` is in flight
    // cannot be in the server's answer, and reading the local set afterwards would put it in the
    // comparison and delete the only copy of it. Capturing first can only ever SPARE.
    let local = ['old'];
    const mlsService = makeMls({
      getLocalGroups: vi.fn(() => [...local]),
      getUserGroups: vi.fn(async () => {
        local = ['old', 'born-during-the-fetch'];
        return [{ groupId: 'old', name: 'o' }];
      }),
    });

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', vi.fn());

    expect([...snapshot.localGroups]).toEqual(['old']);
    expect(snapshot.localGroups.has('born-during-the-fetch')).toBe(false);
  });

  it('collapses a repeated row, keeping the first occurrence', async () => {
    const mlsService = makeMls({
      getUserGroups: vi.fn().mockResolvedValue([
        { groupId: 'g', name: 'first' },
        { groupId: 'g', name: 'second' },
      ]),
    });

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', vi.fn());

    expect(snapshot.serverGroups).toHaveLength(1);
    expect(snapshot.serverGroups[0]?.name).toBe('first');
  });

  it('refuses a list that could not be fetched, and says so out loud', async () => {
    const log = vi.fn();
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['held']),
      getUserGroups: vi.fn().mockRejectedValue(new Error('502')),
    });

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', log);

    expect(snapshot.fetchOk).toBe(false);
    expect(snapshot.absenceIsEvidence).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch user groups'));
  });

  it('refuses an EMPTY list while this device holds trees', async () => {
    const mlsService = makeMls({ getLocalGroups: vi.fn().mockReturnValue(['held']) });

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', vi.fn());

    expect(snapshot.fetchOk).toBe(true);
    expect(snapshot.absenceIsEvidence).toBe(false);
    expect(snapshot.unusableReason).toContain('empty');
  });

  it('BELIEVES an empty list when this device holds nothing - that is a real empty account', async () => {
    // The guard is about the two reads DISAGREEING, not about emptiness. A device with no trees has
    // nothing at risk, and refusing here would be a second, silent way to never sweep anything.
    const snapshot = await readGroupSweepSnapshot(makeMls(), 'u', vi.fn());

    expect(snapshot.absenceIsEvidence).toBe(true);
    expect(snapshot.unusableReason).toBeNull();
  });
});

describe('forgetGroupsAbsentFromServer', () => {
  it('forgets what the server did not name, and logs the reason it was given', async () => {
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['kept', 'gone']),
      getUserGroups: vi.fn().mockResolvedValue([{ groupId: 'kept', name: 'k' }]),
    });
    const log = vi.fn();

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', log);
    const mutated = await forgetGroupsAbsentFromServer(mlsService, snapshot, log);

    expect(mutated).toBe(true);
    expect(mlsService.forgetGroup).toHaveBeenCalledWith('gone', 0);
    expect(mlsService.forgetGroup).not.toHaveBeenCalledWith('kept', 0);
    // The reason travels into the line, which is the sentence a reader reaches for when a group is
    // gone and nobody knows why. Discovery's copy of this loop printed no reason at all.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dm_groups row alive'));
  });

  it('spares a group the decision keeps, without asking WASM to forget it', async () => {
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['seed-carrier']),
      getUserGroups: vi.fn().mockResolvedValue([{ groupId: 'other', name: 'o' }]),
      getGroupServerStatus: vi.fn().mockResolvedValue({
        groupId: 'seed-carrier',
        deletedAt: null,
        distributionWorkspaceId: 'w',
      }),
    });
    const log = vi.fn();

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', log);

    expect(await forgetGroupsAbsentFromServer(mlsService, snapshot, log)).toBe(false);
    expect(mlsService.forgetGroup).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WASM kept'));
  });

  it('asks nothing at all when the list may not be believed', async () => {
    // Not merely "forgets nothing": it does not even make the per-group request, because absence
    // from an unusable list is not a reason to ask either.
    const mlsService = makeMls({ getLocalGroups: vi.fn().mockReturnValue(['held']) });
    const log = vi.fn();

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', log);

    expect(await forgetGroupsAbsentFromServer(mlsService, snapshot, log)).toBe(false);
    expect(mlsService.getGroupServerStatus).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WASM purge skipped'));
  });

  it('says nothing when there was nothing to skip', async () => {
    const mlsService = makeMls({ getUserGroups: vi.fn().mockRejectedValue(new Error('502')) });
    const log = vi.fn();

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', log);
    await forgetGroupsAbsentFromServer(mlsService, snapshot, log);

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('purge skipped'));
  });
});

/**
 * The tree guard, and it is the whole point of the fusion.
 *
 * A unit test of `groupSweep.ts` would have passed on every single day the two sweeps disagreed -
 * both of them were individually consistent, tested, and wrong about each other. What is asserted
 * here is that there is no THIRD copy and no way back to two: the destructive decision has exactly
 * one consumer, and neither sweep takes the local capture itself any more.
 */
const dir = resolve(__dirname, '..', '..');

/**
 * Source with comments removed, so a guard measures CALLS rather than prose about calls - and this
 * file is nothing but prose about the calls it forbids.
 *
 * Through `markupSources`, which owns the one stripper: a hand-rolled `.replace(/\/\/.../)` here
 * would be caught by `markupSources.test.ts`, and rightly - it walks a line rather than matching it,
 * because a `//` inside a URL is not a comment.
 */
const code = (body: string) => withoutAnyComments(body);

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|svelte)$/.test(entry) || /\.(test|spec)\.ts$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe('nobody re-derives the comparison', () => {
  const files = sourceFiles(dir);

  it('`reconcileAbsentLocalGroup` has exactly one caller, and it is the sweep', () => {
    const callers = files
      .filter((file) => !file.endsWith('groupLifecycle.ts'))
      .filter((file) => /\breconcileAbsentLocalGroup\s*\(/.test(code(readFileSync(file, 'utf8'))))
      .map((file) => relative(dir, file).replace(/\\/g, '/'));

    expect(callers).toEqual(['utils/chat/groupSweep.ts']);
  });

  it('neither sweep fetches the group list itself - the order is not theirs to state', () => {
    // `getLocalGroups()` BEFORE the awaited fetch is the one sound order, and both sites had it
    // backwards until 2026-08-30. This is the half that can be asserted from the outside: a site
    // that cannot fetch the list cannot pair it with a capture, and the pairing is the defect. The
    // order INSIDE the pair is pinned by the first test in this file.
    //
    // It is deliberately not asserted for `getLocalGroups` alone. `initializeConnection` reads that
    // a second time on purpose, with a comment saying why - the history reconciliation that follows
    // the sweep must see the joins and purges the sweep just made, which is the opposite
    // requirement to the snapshot's.
    for (const site of ['mls-client/initializeConnection.ts', 'utils/chat/actions.ts']) {
      expect(code(readFileSync(join(dir, site), 'utf8')), site).not.toMatch(/getUserGroups\s*\(/);
    }
  });
});
