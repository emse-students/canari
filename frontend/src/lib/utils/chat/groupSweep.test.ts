import { readSource, relativeTo, sourceFiles } from '../../../test/sourceTree';
import type { IMlsService } from '$lib/mlsService';
import { withoutAnyComments } from '$lib/styles/markupSources';
import { forgetGroupsAbsentFromServer, readGroupSweepSnapshot } from './groupSweep';
import { TransportFailureError } from '$lib/utils/transportFailure';

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

  it('refuses a list that could not be fetched, and says so out loud, once', async () => {
    const log = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['held']),
      getUserGroups: vi.fn().mockRejectedValue(new Error('502')),
    });

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', log);

    expect(snapshot.fetchOk).toBe(false);
    expect(snapshot.absenceIsEvidence).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('Failed to fetch user groups');
    expect(log).not.toHaveBeenCalled();
    error.mockRestore();
  });

  // Production 1.5.1: an absent link at a cold start printed the same failure twice, once at error.
  it('says a list that got NO answer once, as the expected state it is, never at error', async () => {
    const log = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['held']),
      getUserGroups: vi
        .fn()
        .mockRejectedValue(new TransportFailureError(new TypeError('Failed to fetch'))),
    });

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', log);

    expect(snapshot.absenceIsEvidence).toBe(false);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('got no answer'));
    error.mockRestore();
  });

  it('refuses an EMPTY list while this device holds trees', async () => {
    const mlsService = makeMls({ getLocalGroups: vi.fn().mockReturnValue(['held']) });

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', vi.fn());

    expect(snapshot.fetchOk).toBe(true);
    expect(snapshot.absenceIsEvidence).toBe(false);
    expect(snapshot.unusableReason).toContain('empty');
  });

  it('BELIEVES an empty list when the only trees held are key groups, which the list never names', async () => {
    // Review of #2493: any community member holds key-group trees, and `GET /mls/users/:id/groups`
    // leaves distribution groups out by construction - so a joiner whose only ask was declined got
    // an empty list it could never believe, and neither recovery nor discovery could end the ask.
    const mlsService = makeMls({
      getLocalGroups: vi.fn().mockReturnValue(['key-group']),
      isDistributionGroup: vi.fn((id: string) => id === 'key-group'),
    });

    const snapshot = await readGroupSweepSnapshot(mlsService, 'u', vi.fn());

    expect(snapshot.absenceIsEvidence).toBe(true);
    expect(snapshot.unusableReason).toBeNull();
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

  it('asks about a kept key group ONCE per connection pass, not once per sweep', async () => {
    // Pixel 6a, prod 1.2.7, 2026-10-14: the sync sweep and discovery each asked about the same 8
    // key-distribution groups on every connection - 16 requests, 16 `WASM kept` lines.
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
    const verdicts = new Map();

    // The sync sweep, then discovery: two snapshots, one pass.
    for (let sweep = 0; sweep < 2; sweep++) {
      const snapshot = await readGroupSweepSnapshot(mlsService, 'u', log);
      await forgetGroupsAbsentFromServer(mlsService, snapshot, log, verdicts);
    }

    expect(mlsService.getGroupServerStatus).toHaveBeenCalledTimes(1);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('WASM kept'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('not asked again'))).toHaveLength(1);
  });

  it('asks again on a new pass, and forgets a group that stopped being a key group in between', async () => {
    // The first pass hears `keep` (a live key group); by the next pass the community was deleted,
    // its row tombstoned with the scope cleared. A pass whose answers outlived it would spare the
    // orphan for ever; a fresh pass reads the row again and collects it.
    let local = ['seed-carrier'];
    const getGroupServerStatus = vi
      .fn()
      .mockResolvedValueOnce({
        groupId: 'seed-carrier',
        deletedAt: null,
        distributionWorkspaceId: 'w',
      })
      .mockResolvedValueOnce({ groupId: 'seed-carrier', deletedAt: '2026-10-14T00:00:00Z' });
    const mlsService = makeMls({
      getLocalGroups: vi.fn(() => [...local]),
      getUserGroups: vi.fn().mockResolvedValue([{ groupId: 'other', name: 'o' }]),
      getGroupServerStatus,
      forgetGroup: vi.fn(() => {
        local = [];
      }),
    });

    const passes = [new Map(), new Map()];
    for (const verdicts of passes) {
      const snapshot = await readGroupSweepSnapshot(mlsService, 'u', vi.fn());
      await forgetGroupsAbsentFromServer(mlsService, snapshot, vi.fn(), verdicts);
    }

    expect(getGroupServerStatus).toHaveBeenCalledTimes(2);
    expect(mlsService.forgetGroup).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a keep that was only the doubt of an unreadable row', async () => {
    // The first sweep of the pass cannot read the row (transport failure -> `unknown` -> keep on
    // doubt). The second sweep of the SAME pass must ask again, and when the server answers that the
    // row is gone the orphan is removed rather than spared on a non-answer.
    let local = ['orphan'];
    const getGroupServerStatus = vi
      .fn()
      .mockResolvedValueOnce('error')
      .mockResolvedValueOnce('absent');
    const mlsService = makeMls({
      getLocalGroups: vi.fn(() => [...local]),
      getUserGroups: vi.fn().mockResolvedValue([{ groupId: 'other', name: 'o' }]),
      getGroupServerStatus,
      forgetGroup: vi.fn(() => {
        local = [];
      }),
    });
    const verdicts = new Map();

    for (let sweep = 0; sweep < 2; sweep++) {
      const snapshot = await readGroupSweepSnapshot(mlsService, 'u', vi.fn());
      await forgetGroupsAbsentFromServer(mlsService, snapshot, vi.fn(), verdicts);
    }

    expect(getGroupServerStatus).toHaveBeenCalledTimes(2);
    expect(mlsService.forgetGroup).toHaveBeenCalledTimes(1);
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
/**
 * Source with comments removed, so a guard measures CALLS rather than prose about calls - and this
 * file is nothing but prose about the calls it forbids.
 *
 * Through `markupSources`, which owns the one stripper: a hand-rolled `.replace(/\/\/.../)` here
 * would be caught by `markupSources.test.ts`, and rightly - it walks a line rather than matching it,
 * because a `//` inside a URL is not a comment.
 */
const code = (body: string) => withoutAnyComments(body);

describe('nobody re-derives the comparison', () => {
  const files = sourceFiles({ under: 'src/lib', extensions: ['ts', 'svelte'], tests: 'exclude' });

  it('`reconcileAbsentLocalGroup` has exactly one caller, and it is the sweep', () => {
    const callers = files
      .filter(({ path }) => !path.endsWith('groupLifecycle.ts'))
      .filter(({ text }) => /\breconcileAbsentLocalGroup\s*\(/.test(code(text)))
      .map(({ path }) => relativeTo(path, 'src/lib'));

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
      expect(code(readSource(`src/lib/${site}`)), site).not.toMatch(/getUserGroups\s*\(/);
    }
  });
});
