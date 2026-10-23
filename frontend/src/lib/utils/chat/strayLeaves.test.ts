import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { GroupRosterBatch } from '$lib/mls-client/mlsDeliveryApi';
import { UnpublishedBranchError } from '$lib/mls-client/publishedBranch';
import { removeStrayLeaves } from './strayLeaves';

/**
 * A leaver's leaf outlives the leaver, and only a remaining member can collect it.
 *
 * `leaveGroupAndBroadcast` stages no Remove for its own leaf and cannot - a departing member is
 * exactly the party that may not commit its own eviction. These pin the diff that finally does it
 * for a CONVERSATION, every case in which it must NOT remove anybody, and the read it costs: ONE
 * roster read for every held group, taken after every tree - and, only where that read names a
 * stray, the group decided again on a fresh tree and a fresh roster before the commit.
 */

let trees: Record<string, string[]>;
let batch: GroupRosterBatch;
let getGroupMemberIdentities: ReturnType<typeof vi.fn>;
let getGroupRosters: ReturnType<typeof vi.fn>;
let getGroupUserMembers: ReturnType<typeof vi.fn>;
let removeMember: ReturnType<typeof vi.fn>;
let removeMemberDevice: ReturnType<typeof vi.fn>;
let getLocalGroups: ReturnType<typeof vi.fn>;
let calls: string[];
let lines: string[];

const log = (m: string) => lines.push(m);

const mls = () =>
  ({
    getGroupMemberIdentities,
    getGroupRosters,
    getGroupUserMembers,
    removeMember,
    removeMemberDevice,
    getLocalGroups,
    getDeviceId: () => 'web-1',
    getEpoch: () => 12,
  }) as unknown as IMlsService;

const answered = (
  rosters: Record<string, string[]>,
  refused: string[] = [],
  revoked: Record<string, string[]> = {}
): GroupRosterBatch => ({
  rosters: new Map(Object.entries(rosters)),
  refused: new Set(refused),
  revoked: new Map(Object.entries(revoked)),
});

beforeEach(() => {
  lines = [];
  calls = [];
  trees = { g1: ['alice:web-1', 'bob:web-1'] };
  batch = answered({ g1: ['alice', 'bob'] });
  getGroupMemberIdentities = vi.fn(async (g: string) => {
    calls.push(`tree:${g}`);
    return trees[g] ?? [];
  });
  getGroupRosters = vi.fn(async (ids: string[]) => {
    calls.push(`rosters:${ids.join(',')}`);
    return batch;
  });
  getGroupUserMembers = vi.fn(async (g: string) => {
    calls.push(`roster:${g}`);
    return [{ userId: 'alice' }, { userId: 'bob' }];
  });
  removeMember = vi.fn().mockResolvedValue(undefined);
  removeMemberDevice = vi.fn().mockResolvedValue(undefined);
  getLocalGroups = vi.fn().mockReturnValue(['g1', 'g2', 'g3']);
});

describe('removeStrayLeaves', () => {
  it('removes the leaf of a member the roster no longer names', async () => {
    trees.g1 = ['alice:web-1', 'bob:web-1', 'bob:android-9'];
    batch = answered({ g1: ['alice'] });
    getGroupUserMembers.mockImplementation(async (g: string) => {
      calls.push(`roster:${g}`);
      return [{ userId: 'alice' }];
    });

    const changed = await removeStrayLeaves(mls(), ['g1'], 'alice', log);

    expect(changed).toEqual(['g1']);
    // Decided again before the commit: the tree, THEN the roster, as the per-group read did.
    expect(calls).toEqual(['tree:g1', 'rosters:g1', 'tree:g1', 'roster:g1']);
    expect(getGroupUserMembers).toHaveBeenCalledExactlyOnceWith('g1');
    // ONE commit covers every device of every stray, so a departure costs one epoch whatever the
    // fleet behind it - both of bob's leaves go in the same breath.
    expect(removeMember).toHaveBeenCalledExactlyOnceWith('g1', ['bob']);
    expect(lines.join(' | ')).toContain('1 member(s) left but still hold a leaf');
  });

  it('reads every roster in ONE request, after EVERY tree', async () => {
    trees = { g1: ['alice:w'], g2: ['alice:w', 'carol:w'], g3: ['alice:w'] };
    batch = answered({ g1: ['alice'], g2: ['alice', 'carol'], g3: ['alice'] });

    await removeStrayLeaves(mls(), ['g1', 'g2', 'g3'], 'alice', log);

    // The count the change exists for: one roster read, not one per group.
    expect(getGroupRosters).toHaveBeenCalledTimes(1);
    expect(getGroupUserMembers).not.toHaveBeenCalled();
    // The order that keeps it sound: a roster read before a tree would name a leaf that joined in
    // between as a stray.
    expect(calls).toEqual(['tree:g1', 'tree:g2', 'tree:g3', 'rosters:g1,g2,g3']);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('decides nothing for a group the batch did not answer - an older server, a failed chunk', async () => {
    // No second path: one read per group is the storm the batch removed, and it would be silent
    // the day the batch broke. A stray survives until the next connection, the safe direction.
    trees.g1 = ['alice:web-1', 'bob:web-1'];
    batch = answered({});

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(getGroupUserMembers).not.toHaveBeenCalled();
    expect(removeMember).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('1 not answered (nobody removed in them)');
  });

  it('spares a member who left before the batch read and came back after it', async () => {
    // The batch roster is as old as the start of the pass, and a removal by user id takes EVERY
    // leaf of that user - the fresh one too. The fresh roster read before the commit names him.
    batch = answered({ g1: ['alice'] });
    getGroupUserMembers.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('back in the roster');
  });

  it('removes nobody from a group whose roster was refused, and does not ask again', async () => {
    // The single read's 403, per group: this user is not in the roster. Read as an EMPTY roster it
    // would remove everybody but this device.
    batch = answered({}, ['g1']);

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
    expect(getGroupUserMembers).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('roster refused');
  });

  it('commits nothing when the tree already agrees with the roster', async () => {
    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('reads nothing at all when this device holds none of the groups', async () => {
    // Only a member may commit. The connection loop hands over every group the SERVER lists, most
    // of which this device may not hold, so it must be cheap and silent rather than an error.
    getLocalGroups.mockReturnValue([]);

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(getGroupRosters).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('removes nobody when the roster could not be read', async () => {
    // A fetch that threw is not an empty conversation, and treating it as one would empty the tree
    // of everybody but this device. Absence is a reason to ask again later, never to destroy.
    batch = answered({ g1: ['alice'] });
    getGroupUserMembers.mockRejectedValue(new Error('502'));

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('could not confirm the tree against its roster');
  });

  it('never removes this device, whatever the roster says', async () => {
    // A device that removed its own leaf would leave the conversation it is holding open, with no
    // way back in but a fresh external join.
    batch = answered({ g1: [] });
    getGroupUserMembers.mockResolvedValue([]);

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual(['g1']);
    expect(removeMember).toHaveBeenCalledExactlyOnceWith('g1', ['bob']);
  });

  it('names only strays still in the tree when it commits', async () => {
    // Another member's commit removed bob after this pass read the tree: committing his removal
    // again would be refused, and reported as a failure that never happened.
    batch = answered({ g1: ['alice'] });
    getGroupUserMembers.mockResolvedValue([{ userId: 'alice' }]);
    getGroupMemberIdentities
      .mockResolvedValueOnce(['alice:web-1', 'bob:web-1'])
      .mockResolvedValueOnce(['alice:web-1']);

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('removed by another member');
  });

  it('reports a refused commit rather than claiming the leaves are gone', async () => {
    // Until the commit lands, everyone named still holds key material for the conversation.
    batch = answered({ g1: ['alice'] });
    getGroupUserMembers.mockResolvedValue([{ userId: 'alice' }]);
    removeMember.mockRejectedValue(new Error('epoch_mismatch'));

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(lines.join(' | ')).toContain('their leaves stay');
  });

  it('says the departed leaves are gone when another member removed them first', async () => {
    trees.g1 = ['alice:web-1', 'bob:web-1'];
    batch = answered({ g1: ['alice'] });
    getGroupUserMembers.mockResolvedValue([{ userId: 'alice' }]);
    removeMember.mockImplementation(async () => {
      trees.g1 = ['alice:web-1'];
      throw new Error('epoch_mismatch');
    });

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    const said = lines.join(' | ');
    expect(said).not.toContain('their leaves stay');
    expect(said).toContain('already gone from the tree');
  });
});

/**
 * A REVOKED DEVICE'S LEAF OUTLIVES THE REVOCATION, which purges routing and cannot touch a tree.
 * The collector removes it - and ONLY a leaf the server names as revoked (an allowlist): a leaf the
 * routing table merely forgot is a device fresh-start, not a revocation.
 */
describe('removeStrayLeaves - revoked devices', () => {
  it('removes the leaf of a revoked device whose owner stays in the conversation', async () => {
    trees.g1 = ['alice:web-1', 'bob:web-1', 'bob:phone-1'];
    batch = answered({ g1: ['alice', 'bob'] }, [], { g1: ['bob:phone-1'] });

    const changed = await removeStrayLeaves(mls(), ['g1'], 'alice', log);

    expect(changed).toEqual(['g1']);
    // Decided again on a fresh tree and a fresh answer before the commit, like a departure.
    expect(calls).toEqual(['tree:g1', 'rosters:g1', 'tree:g1', 'rosters:g1']);
    expect(removeMemberDevice).toHaveBeenCalledExactlyOnceWith('g1', ['bob:phone-1']);
    // bob is still a member: his other device keeps its leaf, and nobody is removed by user.
    expect(removeMember).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('revoked');
  });

  it('removes another revoked device of this user, never this device itself', async () => {
    trees.g1 = ['alice:web-1', 'alice:android-2', 'bob:web-1'];
    batch = answered({ g1: ['alice', 'bob'] }, [], { g1: ['alice:web-1', 'alice:android-2'] });

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual(['g1']);
    expect(removeMemberDevice).toHaveBeenCalledExactlyOnceWith('g1', ['alice:android-2']);
    expect(lines.join(' | ')).toContain('THIS device is listed as revoked');
  });

  it('removes nothing the server did not name as revoked', async () => {
    // A revoked identity absent from the tree, and a leaf present with no revocation: no commit.
    trees.g1 = ['alice:web-1', 'bob:web-1'];
    batch = answered({ g1: ['alice', 'bob'] }, [], { g1: ['bob:old-phone'] });

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(removeMemberDevice).not.toHaveBeenCalled();
    expect(calls).toEqual(['tree:g1', 'rosters:g1']);
  });

  it('removes nothing when the fresh read no longer names the device', async () => {
    trees.g1 = ['alice:web-1', 'bob:web-1', 'bob:phone-1'];
    batch = answered({ g1: ['alice', 'bob'] }, [], { g1: ['bob:phone-1'] });
    getGroupRosters
      .mockImplementationOnce(async (ids: string[]) => {
        calls.push(`rosters:${ids.join(',')}`);
        return batch;
      })
      .mockImplementationOnce(async (ids: string[]) => {
        calls.push(`rosters:${ids.join(',')}`);
        return answered({});
      });

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(removeMemberDevice).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('no revoked leaf left on a fresh read');
  });

  it('reports a refused removal rather than claiming the leaf is gone', async () => {
    trees.g1 = ['alice:web-1', 'bob:web-1', 'bob:phone-1'];
    batch = answered({ g1: ['alice', 'bob'] }, [], { g1: ['bob:phone-1'] });
    removeMemberDevice.mockRejectedValue(new Error('epoch_mismatch'));

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    expect(lines.join(' | ')).toContain('could not remove 1 revoked device(s)');
  });

  it('removes nothing from a state the published base cannot vouch for, and says why', async () => {
    // The removal is a commit nobody asked for: on a forked device it would be accepted by the
    // epoch gate and break every healthy member, so the service stages nothing and says so.
    trees.g1 = ['alice:web-1', 'bob:web-1', 'bob:phone-1'];
    batch = answered({ g1: ['alice', 'bob'] }, [], { g1: ['bob:phone-1'] });
    removeMemberDevice.mockRejectedValue(
      new UnpublishedBranchError('g1', 'diverged', 'revoked-leaf removal')
    );

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    const said = lines.join(' | ');
    expect(said).toContain('NOT removed: the published base cannot vouch');
    expect(said).toContain('(diverged)');
    // Not reported as a refusal that left leaves: nothing was staged, the tree is not re-read.
    expect(said).not.toContain('could not remove');
  });

  it('says the leaf is gone, not that it stays, when another member removed it first', async () => {
    // Two members' collectors race; the loser's commit is refused BECAUSE the winner's removed the
    // leaf. "Their leaves stay" would then be false - the tree is read again and says what happened.
    trees.g1 = ['alice:web-1', 'bob:web-1', 'bob:phone-1'];
    batch = answered({ g1: ['alice', 'bob'] }, [], { g1: ['bob:phone-1'] });
    removeMemberDevice.mockImplementation(async () => {
      trees.g1 = ['alice:web-1', 'bob:web-1'];
      throw new Error('epoch_mismatch');
    });

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual([]);
    const said = lines.join(' | ');
    expect(said).not.toContain('their leaves stay');
    expect(said).toContain('already gone from the tree');
  });

  it('removes a departed member first, then a revoked device of one who stays', async () => {
    trees.g1 = ['alice:web-1', 'bob:web-1', 'bob:phone-1', 'carol:web-1'];
    batch = answered({ g1: ['alice', 'bob'] }, [], { g1: ['bob:phone-1'] });
    getGroupUserMembers.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);

    expect(await removeStrayLeaves(mls(), ['g1'], 'alice', log)).toEqual(['g1']);
    expect(removeMember).toHaveBeenCalledExactlyOnceWith('g1', ['carol']);
    expect(removeMemberDevice).toHaveBeenCalledExactlyOnceWith('g1', ['bob:phone-1']);
  });
});
