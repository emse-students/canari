import type { ChannelService } from '$lib/services/ChannelService';
import {
  diffRosterAgainstTree,
  reconcileDistributionGroupRoster,
  reconcileDistributionGroupRosterReported,
} from './rosterReconcile';
import {
  AcceptedCommitNotMergedError,
  CommitOutcomeUnknownError,
} from '$lib/mls-client/commitSubmission';
import { userIdOfLeaf } from '$lib/mls-client/leafIdentity';
import { setGraineRuntime } from './runtime';
import { channelScope, workspaceScope } from '$lib/mls-client/distributionScope';
import { UnpublishedBranchError } from '$lib/mls-client/publishedBranch';
import { DEADLINE_MS, fetchUnderDeadline } from '$lib/utils/requestDeadline';

/**
 * A departure must move the distribution group's epoch (WP-GRAINE-2).
 *
 * The rotation Graine already implements fires on an epoch that changed. Nothing ever changed it,
 * so a member who left kept a seed that opened every message sent afterwards, and their leaf would
 * have received every seed minted afterwards. These pin the diff that makes the epoch move, and -
 * just as important - every case in which it must NOT.
 */

/** The admission ledger's observation (section 25) - its rules are `admissionGate.test.ts`'s. */
const observeAdmissionState = vi.fn();
vi.mock('./admissionGate', () => ({
  observeAdmissionState: (...args: unknown[]) => observeAdmissionState(...args),
}));

let getGroupMemberIdentities: ReturnType<typeof vi.fn>;
let removeDepartedMembers: ReturnType<typeof vi.fn>;
let getLocalGroups: ReturnType<typeof vi.fn>;
let distributionGroupFor: ReturnType<typeof vi.fn>;
let persisted: number;
const listWorkspaceMembers = vi.fn();
const listMembers = vi.fn();

const channelService = {
  listWorkspaceMembers: (workspaceId: string) => listWorkspaceMembers(workspaceId),
  listMembers: (channelId: string, scope: string) => listMembers(channelId, scope),
} as unknown as ChannelService;

beforeEach(() => {
  getGroupMemberIdentities = vi.fn().mockResolvedValue(['alice:web-1', 'bob:web-1']);
  removeDepartedMembers = vi.fn().mockResolvedValue(undefined);
  getLocalGroups = vi.fn().mockReturnValue(['dist-group']);
  distributionGroupFor = vi.fn().mockReturnValue('dist-group');
  listWorkspaceMembers.mockReset();
  listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);
  listMembers.mockReset();
  listMembers.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);
  observeAdmissionState.mockReset();
  observeAdmissionState.mockResolvedValue(undefined);
  persisted = 0;

  setGraineRuntime({
    storage: {} as never,
    deviceKey: () => 'device-key',
    userId: 'alice',
    mlsService: {
      distributionGroupFor,
      getLocalGroups,
      getGroupMemberIdentities,
      removeDepartedMembers,
      getEpoch: () => 26,
      persistCheckpoint: vi.fn().mockImplementation(async () => {
        persisted += 1;
      }),
    } as never,
  });
});

afterEach(() => {
  setGraineRuntime(null);
});

describe('userIdOfLeaf', () => {
  it('splits on the one colon an identity may carry, and refuses one with more', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(userIdOfLeaf('alice:web-alice-abcd-1234')).toBe('alice');
    // Matches Rust's binding check: a second colon names nobody (`leafIdentity.ts`).
    expect(userIdOfLeaf('alice:tauri:weird')).toBe('');
    error.mockRestore();
  });

  it('answers the whole string when there is no colon at all', () => {
    expect(userIdOfLeaf('alice')).toBe('alice');
  });
});

describe('diffRosterAgainstTree', () => {
  it('names the users the roster no longer holds, once each whatever their device count', () => {
    const diff = diffRosterAgainstTree({
      leafIdentities: ['alice:web-1', 'bob:web-1', 'bob:tauri-1', 'carol:web-1'],
      rosterUserIds: ['alice', 'carol'],
      selfUserId: 'alice',
    });

    expect(diff.strayUserIds).toEqual(['bob']);
    expect(diff.keptLeafCount).toBe(2);
  });

  it('finds nothing when the tree and the roster already agree', () => {
    const diff = diffRosterAgainstTree({
      leafIdentities: ['alice:web-1', 'bob:web-1'],
      rosterUserIds: ['alice', 'bob'],
      selfUserId: 'alice',
    });

    expect(diff.strayUserIds).toEqual([]);
  });

  it('never names this device, whatever the roster says', () => {
    // A device that removed its own leaf would leave the group it is holding open, with no way back
    // in but a fresh external join - and it reads its own roster, so its own absence from it can
    // only be a fetch for the wrong community or a membership row mid-write.
    const diff = diffRosterAgainstTree({
      leafIdentities: ['alice:web-1', 'bob:web-1'],
      rosterUserIds: [],
      selfUserId: 'alice',
    });

    expect(diff.strayUserIds).toEqual(['bob']);
  });

  it('compares user ids case-insensitively, since one list is stored and the other is minted', () => {
    const diff = diffRosterAgainstTree({
      leafIdentities: ['ALICE:web-1', 'BOB:web-1'],
      rosterUserIds: ['alice', 'bob'],
      selfUserId: 'alice',
    });

    expect(diff.strayUserIds).toEqual([]);
  });
});

describe('reconcileDistributionGroupRoster', () => {
  it('commits ONE removal covering every departed member, then persists the new epoch', async () => {
    getGroupMemberIdentities.mockResolvedValue([
      'alice:web-1',
      'bob:web-1',
      'bob:tauri-1',
      'carol:web-1',
    ]);
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }]);

    await expect(
      reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'))
    ).resolves.toEqual(['bob', 'carol']);

    // One commit, one epoch, whatever the fleet behind the departures.
    expect(removeDepartedMembers).toHaveBeenCalledTimes(1);
    expect(removeDepartedMembers).toHaveBeenCalledWith('dist-group', ['bob', 'carol']);
    // An epoch that only ever existed in memory is one the next load walks back out of.
    expect(persisted).toBe(1);
  });

  it('commits nothing when the tree already agrees with the roster, and SAYS it ran', async () => {
    const lines: string[] = [];

    await expect(
      reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'), (m) => lines.push(m))
    ).resolves.toEqual([]);

    expect(removeDepartedMembers).not.toHaveBeenCalled();
    expect(persisted).toBe(0);
    // A pass whose success is indistinguishable from its absence can only be verified against the
    // database - which is how this mechanism had to be checked on prod the first time.
    expect(lines.some((l) => /agrees with its roster/.test(l))).toBe(true);
  });

  it('records the admission state at every community sync, with the roster it read', async () => {
    await reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'));

    // The roots are fixed HERE, at the first sync - never at a moment an ask chooses.
    expect(observeAdmissionState).toHaveBeenCalledWith('ws-1', 'dist-group', [
      { userId: 'alice' },
      { userId: 'bob' },
    ]);
  });

  it('still reconciles when the admission state cannot be recorded, and says so', async () => {
    observeAdmissionState.mockRejectedValue(new Error('tree unreadable'));
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }]);
    const lines: string[] = [];

    await reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'), (m) =>
      lines.push(m)
    );

    expect(removeDepartedMembers).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => /admission state .* not recorded/.test(l))).toBe(true);
  });

  it('REMOVES NOBODY when the roster could not be read', async () => {
    // The whole reason this is a separate case: a fetch that threw is not an empty community, and
    // reading it as one would empty the tree of everyone but this device.
    listWorkspaceMembers.mockRejectedValue(new Error('offline'));

    await expect(
      reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'))
    ).resolves.toEqual([]);
    expect(removeDepartedMembers).not.toHaveBeenCalled();
  });

  it('removes nobody when the tree could not be read', async () => {
    getGroupMemberIdentities.mockRejectedValue(new Error('group not found'));

    await expect(
      reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'))
    ).resolves.toEqual([]);
    expect(removeDepartedMembers).not.toHaveBeenCalled();
  });

  it('does not even look when this device has not joined the group', async () => {
    getLocalGroups.mockReturnValue([]);

    await expect(
      reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'))
    ).resolves.toEqual([]);
    expect(getGroupMemberIdentities).not.toHaveBeenCalled();
    expect(listWorkspaceMembers).not.toHaveBeenCalled();
  });

  it('reports a rejected commit and persists nothing', async () => {
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }]);
    removeDepartedMembers.mockRejectedValue(new Error('epoch rejected'));
    const lines: string[] = [];

    await expect(
      reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'), (m) => lines.push(m))
    ).resolves.toEqual([]);

    expect(persisted).toBe(0);
    // The tree, read again, still holds bob: until a commit lands he can read everything.
    expect(lines.some((l) => l.includes('1 of them still hold a leaf and can still read it'))).toBe(
      true
    );
  });

  it('says "already gone" when the refused removal was made by another device first', async () => {
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }]);
    // First read decides the Remove; the read after the refusal finds bob gone.
    getGroupMemberIdentities
      .mockResolvedValueOnce(['alice:web-1', 'bob:web-1'])
      .mockResolvedValueOnce(['alice:web-1']);
    removeDepartedMembers.mockRejectedValue(new Error('epoch rejected'));
    const lines: string[] = [];

    await reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'), (m) =>
      lines.push(m)
    );

    const said = lines.join(' | ');
    expect(said).toContain('already gone from the tree - another device removed them first');
    expect(said).not.toContain('can still read it');
  });

  // The removal is a commit the DIFF decided, so it is staged only on the published branch: each
  // reason is a non-refusal, said as one, and never the accusing "they can still read it".
  it.each(['no-base', 'other-epoch', 'diverged'] as const)(
    'removes nobody from a state the published base cannot vouch for (%s), and says why',
    async (reason) => {
      listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }]);
      removeDepartedMembers.mockRejectedValue(
        new UnpublishedBranchError('dist-group', reason, 'departed-member removal')
      );
      const lines: string[] = [];

      await expect(
        reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'), (m) =>
          lines.push(m)
        )
      ).resolves.toEqual([]);

      expect(persisted).toBe(0);
      const said = lines.join(' | ');
      expect(said).toContain(`cannot vouch for this device's state (${reason}) - nothing staged`);
      expect(said).not.toContain('they can still read it');
    }
  );

  it('is silent and harmless before a session has wired the Graine runtime', async () => {
    setGraineRuntime(null);

    await expect(
      reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'))
    ).resolves.toEqual([]);
    expect(removeDepartedMembers).not.toHaveBeenCalled();
  });
});

describe('a private salon reconciles against ITS OWN roster', () => {
  it('asks the salon who may open it, never the community', async () => {
    getGroupMemberIdentities.mockResolvedValue(['alice:web-1', 'bob:web-1', 'carol:web-1']);
    // The community has everybody; the salon has two of them. Reading the community's roster here
    // is what would re-authorise, at every pass, exactly the leaves the salon had just removed.
    listWorkspaceMembers.mockResolvedValue([
      { userId: 'alice' },
      { userId: 'bob' },
      { userId: 'carol' },
    ]);
    listMembers.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);

    await expect(
      reconcileDistributionGroupRoster(channelService, channelScope('ws-1', 'chan-1'))
    ).resolves.toEqual(['carol']);

    expect(listMembers).toHaveBeenCalledWith('chan-1', 'channel');
    expect(listWorkspaceMembers).not.toHaveBeenCalled();
    expect(removeDepartedMembers).toHaveBeenCalledWith('dist-group', ['carol']);
  });

  it('looks the group up under the salon scope, not the community one', async () => {
    listMembers.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);

    await reconcileDistributionGroupRoster(channelService, channelScope('ws-1', 'chan-1'));

    expect(distributionGroupFor).toHaveBeenCalledWith(channelScope('ws-1', 'chan-1'));
  });

  it('removes nobody when the salon roster could not be read', async () => {
    listMembers.mockRejectedValue(new Error('502'));

    await expect(
      reconcileDistributionGroupRoster(channelService, channelScope('ws-1', 'chan-1'))
    ).resolves.toEqual([]);

    // Absence is a reason to ask again later, never to empty the tree of everybody but this device.
    expect(removeDepartedMembers).not.toHaveBeenCalled();
  });
});

/**
 * ONE PASS PER SCOPE AT A TIME (2026-10-27). The actor of a removal runs a pass the moment the
 * server accepts it, so it can meet a load's pass on the same scope: two passes reading one tree
 * would both decide the same Remove. A caller arriving during a pass waits for it - that pass may
 * have read the roster before the caller's server write - and callers arriving while a pass still
 * waits share it, since it has read nothing yet.
 */
describe('reconcileDistributionGroupRoster - one pass per scope at a time', () => {
  it('starts the next pass only after the running one, and shares a pass that has not started', async () => {
    let releaseFirst: () => void = () => {};
    let reads = 0;
    listWorkspaceMembers.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) await new Promise<void>((r) => (releaseFirst = r));
      return [{ userId: 'alice' }, { userId: 'bob' }];
    });

    const first = reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'));
    await Promise.resolve();
    await Promise.resolve();
    const second = reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'));
    const third = reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'));

    // The second waits for the first, which is still reading; the third shares the second.
    expect(third).toBe(second);
    await Promise.resolve();
    expect(reads).toBe(1);

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(reads).toBe(2);
  });

  it('logs a shared pass through every caller that shares it', async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let reads = 0;
    listWorkspaceMembers.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) await firstGate;
      return [{ userId: 'alice' }, { userId: 'bob' }];
    });
    const a: string[] = [];
    const b: string[] = [];

    const first = reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'));
    await Promise.resolve();
    const second = reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'), (m) =>
      a.push(m)
    );
    const third = reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'), (m) =>
      b.push(m)
    );
    releaseFirst();
    await Promise.all([first, second, third]);

    expect(a.some((l) => l.includes('agrees with its roster'))).toBe(true);
    expect(b.some((l) => l.includes('agrees with its roster'))).toBe(true);
  });

  it('a HUNG roster read ends on its typed deadline and releases the lane - termination', async () => {
    // The real deadline primitive `apiFetch` sends every request through, over a server that never
    // answers: nothing here rejects the read by hand. Fake time is the only thing advanced.
    vi.useFakeTimers();
    try {
      const neverAnswers = ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        )) as unknown as typeof fetch;
      listWorkspaceMembers.mockImplementationOnce(() =>
        fetchUnderDeadline(neverAnswers, '/api/members', {}, 'read', DEADLINE_MS.read)
      );
      const lines: string[] = [];

      const hung = reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'), (m) =>
        lines.push(m)
      );
      // Let it START reading, so the next caller queues behind it rather than sharing it.
      await vi.advanceTimersByTimeAsync(0);
      expect(listWorkspaceMembers).toHaveBeenCalledTimes(1);
      const next = reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS.read - 1);
      // Still hung, and the next pass waits behind it.
      expect(listWorkspaceMembers).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(hung).resolves.toEqual([]);
      expect(lines.join(' ')).toContain('RequestDeadlineError');
      expect(lines.join(' ')).toContain('nobody removed');
      // The lane was released: the queued pass ran its own read.
      await expect(next).resolves.toEqual([]);
      expect(listWorkspaceMembers).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not hold a pass on one scope behind a pass on another', async () => {
    let release: () => void = () => {};
    listWorkspaceMembers.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r([{ userId: 'alice' }, { userId: 'bob' }]);
        })
    );

    const community = reconcileDistributionGroupRoster(channelService, workspaceScope('ws-1'));
    await expect(
      reconcileDistributionGroupRoster(channelService, channelScope('ws-1', 'chan-1'))
    ).resolves.toEqual([]);

    release();
    await community;
  });
});

describe('the pass report - what the actor of a removal releases on', () => {
  // The actor releases a Remove it claimed only on a PROOF that it did not commit it: the report
  // names who holds a leaf of the tree the pass LEFT, and is null whenever that is not known.
  const run = () =>
    reconcileDistributionGroupRosterReported(channelService, workspaceScope('ws-1'), () => {});

  beforeEach(() => {
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }]);
  });

  it('a pass that removed bob reports he holds no leaf', async () => {
    await expect(run()).resolves.toEqual({ removedUserIds: ['bob'], heldUserIds: ['alice'] });
  });

  it('nothing staged (an unvouched base) reports the tree as read - bob still holds a leaf', async () => {
    removeDepartedMembers.mockRejectedValue(
      new UnpublishedBranchError('dist-group', 'other-epoch', 'departed-member removal')
    );
    await expect(run()).resolves.toEqual({ removedUserIds: [], heldUserIds: ['alice', 'bob'] });
  });

  it('a definite refusal reports the tree read again', async () => {
    removeDepartedMembers.mockRejectedValue(new Error('epoch rejected'));
    await expect(run()).resolves.toEqual({ removedUserIds: [], heldUserIds: ['alice', 'bob'] });
  });

  it('a commit with an UNKNOWN outcome reports nothing known - it may yet land', async () => {
    const lines: string[] = [];
    removeDepartedMembers.mockRejectedValue(
      new CommitOutcomeUnknownError('dist-group', 26, new Error('no answer'))
    );
    await expect(
      reconcileDistributionGroupRosterReported(channelService, workspaceScope('ws-1'), (m) =>
        lines.push(m)
      )
    ).resolves.toEqual({ removedUserIds: [], heldUserIds: null });
    expect(lines.join(' | ')).toContain('sent and NOT answered');
    expect(lines.join(' | ')).not.toContain('can still read it');
  });

  it('a commit the server ACCEPTED and this device failed to merge is no refusal - it landed', async () => {
    const lines: string[] = [];
    removeDepartedMembers.mockRejectedValue(
      new AcceptedCommitNotMergedError('dist-group', 26, new Error('merge failed'))
    );
    await expect(
      reconcileDistributionGroupRosterReported(channelService, workspaceScope('ws-1'), (m) =>
        lines.push(m)
      )
    ).resolves.toEqual({ removedUserIds: [], heldUserIds: null });
    // The tree here is the one BEFORE the commit: read again, it would say he still holds a leaf.
    expect(lines.join(' | ')).toContain('ACCEPTED by the server and NOT merged here');
    expect(lines.join(' | ')).not.toContain('can still read it');
  });

  it('a roster it could not read reports the tree as read, nothing having been staged', async () => {
    listWorkspaceMembers.mockRejectedValue(new Error('502'));
    await expect(run()).resolves.toEqual({ removedUserIds: [], heldUserIds: ['alice', 'bob'] });
  });

  it('a group this device does not hold reports nothing known', async () => {
    distributionGroupFor.mockReturnValue(null);
    await expect(run()).resolves.toEqual({ removedUserIds: [], heldUserIds: null });
  });
});
