import type { ChannelService } from '$lib/services/ChannelService';
import {
  diffRosterAgainstTree,
  reconcileDistributionGroupRoster,
  userIdOfLeaf,
} from './rosterReconcile';
import { setGraineRuntime } from './runtime';

/**
 * A departure must move the distribution group's epoch (WP-GRAINE-2).
 *
 * The rotation Graine already implements fires on an epoch that changed. Nothing ever changed it,
 * so a member who left kept a seed that opened every message sent afterwards, and their leaf would
 * have received every seed minted afterwards. These pin the diff that makes the epoch move, and -
 * just as important - every case in which it must NOT.
 */

let getGroupMemberIdentities: ReturnType<typeof vi.fn>;
let removeMember: ReturnType<typeof vi.fn>;
let getLocalGroups: ReturnType<typeof vi.fn>;
let distributionGroupFor: ReturnType<typeof vi.fn>;
let persisted: number;
const listWorkspaceMembers = vi.fn();

const channelService = {
  listWorkspaceMembers: (workspaceId: string) => listWorkspaceMembers(workspaceId),
} as unknown as ChannelService;

beforeEach(() => {
  getGroupMemberIdentities = vi.fn().mockResolvedValue(['alice:web-1', 'bob:web-1']);
  removeMember = vi.fn().mockResolvedValue(undefined);
  getLocalGroups = vi.fn().mockReturnValue(['dist-group']);
  distributionGroupFor = vi.fn().mockReturnValue('dist-group');
  listWorkspaceMembers.mockReset();
  listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);
  persisted = 0;

  setGraineRuntime({
    storage: {} as never,
    deviceKeyB64: 'device-key',
    userId: 'alice',
    mlsService: {
      distributionGroupFor,
      getLocalGroups,
      getGroupMemberIdentities,
      removeMember,
      getEpoch: () => 26,
      saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
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
  it('splits on the first colon, because a device id may contain one and a user id may not', () => {
    expect(userIdOfLeaf('alice:web-alice-abcd-1234')).toBe('alice');
    expect(userIdOfLeaf('alice:tauri:weird')).toBe('alice');
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

    await expect(reconcileDistributionGroupRoster(channelService, 'ws-1')).resolves.toEqual([
      'bob',
      'carol',
    ]);

    // One commit, one epoch, whatever the fleet behind the departures.
    expect(removeMember).toHaveBeenCalledTimes(1);
    expect(removeMember).toHaveBeenCalledWith('dist-group', ['bob', 'carol']);
    // An epoch that only ever existed in memory is one the next load walks back out of.
    expect(persisted).toBe(1);
  });

  it('commits nothing when the tree already agrees with the roster', async () => {
    await expect(reconcileDistributionGroupRoster(channelService, 'ws-1')).resolves.toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
    expect(persisted).toBe(0);
  });

  it('REMOVES NOBODY when the roster could not be read', async () => {
    // The whole reason this is a separate case: a fetch that threw is not an empty community, and
    // reading it as one would empty the tree of everyone but this device.
    listWorkspaceMembers.mockRejectedValue(new Error('offline'));

    await expect(reconcileDistributionGroupRoster(channelService, 'ws-1')).resolves.toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('removes nobody when the tree could not be read', async () => {
    getGroupMemberIdentities.mockRejectedValue(new Error('group not found'));

    await expect(reconcileDistributionGroupRoster(channelService, 'ws-1')).resolves.toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('does not even look when this device has not joined the group', async () => {
    getLocalGroups.mockReturnValue([]);

    await expect(reconcileDistributionGroupRoster(channelService, 'ws-1')).resolves.toEqual([]);
    expect(getGroupMemberIdentities).not.toHaveBeenCalled();
    expect(listWorkspaceMembers).not.toHaveBeenCalled();
  });

  it('reports a rejected commit and persists nothing', async () => {
    listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }]);
    removeMember.mockRejectedValue(new Error('epoch rejected'));
    const lines: string[] = [];

    await expect(
      reconcileDistributionGroupRoster(channelService, 'ws-1', (m) => lines.push(m))
    ).resolves.toEqual([]);

    expect(persisted).toBe(0);
    // Until this commit lands they can still read everything, so the failure accuses.
    expect(lines.some((l) => l.includes('they can still read it'))).toBe(true);
  });

  it('is silent and harmless before a session has wired the Graine runtime', async () => {
    setGraineRuntime(null);

    await expect(reconcileDistributionGroupRoster(channelService, 'ws-1')).resolves.toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
  });
});
