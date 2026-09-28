import {
  admitInvitedMember,
  admitNewcomerToDistributionGroup,
  admitSalonGrantee,
  devicesToAdmit,
} from './admitNewcomer';
import { registerChannelWorkspace, setGraineRuntime } from './runtime';
import { channelScope, workspaceScope } from '$lib/mls-client/distributionScope';
import { CommitRefusedError } from '$lib/mls-client/CommitRefusedError';

/**
 * Whoever admits a newcomer Welcomes them (channel-encryption section 20).
 *
 * An admin adding somebody from the community panel is online and holds the key group; the
 * newcomer's phone may be shut. These pin the admit decision - who is added, who is Welcomed, and
 * every case in which NOTHING may be committed.
 */

const kp = (n: number) => new Uint8Array([n]);

let mls: Record<string, ReturnType<typeof vi.fn>>;
let persisted: number;
let lines: string[];
const log = (m: string) => lines.push(m);

beforeEach(() => {
  persisted = 0;
  lines = [];
  mls = {
    distributionGroupFor: vi.fn().mockReturnValue('key-group'),
    getLocalGroups: vi.fn().mockReturnValue(['key-group']),
    fetchUserDevices: vi.fn().mockResolvedValue([
      { deviceId: 'phone', keyPackage: kp(1) },
      { deviceId: 'web', keyPackage: kp(2) },
    ]),
    acquireAddLock: vi.fn().mockResolvedValue(true),
    releaseAddLock: vi.fn().mockResolvedValue(undefined),
    getGroupMemberIdentities: vi.fn().mockResolvedValue(['admin:web-1']),
    addMembersBulk: vi.fn().mockResolvedValue({
      welcome: new Uint8Array([9]),
      ratchetTree: new Uint8Array([8]),
      addedDeviceIds: ['phone', 'web'],
      skippedDeviceIds: [],
    }),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    getEpoch: vi.fn().mockReturnValue(5),
    persistCheckpoint: vi.fn().mockImplementation(async () => {
      persisted += 1;
    }),
  };
  setGraineRuntime({
    storage: {} as never,
    deviceKeyB64: 'device-key',
    userId: 'admin',
    mlsService: mls as never,
  });
});

afterEach(() => {
  setGraineRuntime(null);
});

describe('devicesToAdmit', () => {
  it('keeps only the devices the tree holds no leaf for, case-insensitively', () => {
    const missing = devicesToAdmit({
      leafIdentities: ['admin:web-1', 'BOB:Phone'],
      newcomerUserId: 'bob',
      devices: [
        { deviceId: 'phone', keyPackage: kp(1) },
        { deviceId: 'web', keyPackage: kp(2) },
      ],
    });
    expect(missing.map((d) => d.deviceId)).toEqual(['web']);
  });

  it('is not fooled by another user holding a device of the same name', () => {
    const missing = devicesToAdmit({
      leafIdentities: ['carol:phone'],
      newcomerUserId: 'bob',
      devices: [{ deviceId: 'phone', keyPackage: kp(1) }],
    });
    expect(missing).toHaveLength(1);
  });
});

describe('admitNewcomerToDistributionGroup', () => {
  it('adds every device in ONE commit and sends one Welcome per device', async () => {
    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'Bob', log);

    expect(out).toEqual({
      kind: 'admitted',
      groupId: 'key-group',
      deviceIds: ['phone', 'web'],
      epoch: 5,
    });
    expect(mls.addMembersBulk).toHaveBeenCalledTimes(1);
    expect(mls.addMembersBulk).toHaveBeenCalledWith(
      'key-group',
      [
        { deviceId: 'phone', keyPackage: kp(1) },
        { deviceId: 'web', keyPackage: kp(2) },
      ],
      ['bob:phone', 'bob:web']
    );
    expect(mls.sendWelcome).toHaveBeenCalledTimes(2);
    expect(mls.sendWelcome).toHaveBeenCalledWith(
      new Uint8Array([9]),
      'bob',
      'key-group',
      'phone',
      new Uint8Array([8])
    );
    // The merged epoch is on disk before the Welcomes go out.
    expect(persisted).toBe(1);
    // The lock is taken BEFORE the tree is read, and always released.
    expect(mls.acquireAddLock.mock.invocationCallOrder[0]).toBeLessThan(
      mls.getGroupMemberIdentities.mock.invocationCallOrder[0]
    );
    expect(mls.releaseAddLock).toHaveBeenCalledWith('key-group');
  });

  it('admits NOBODY when the newcomer has published no KeyPackage, and says so', async () => {
    mls.fetchUserDevices.mockResolvedValue([]);

    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(out).toEqual({ kind: 'no-key-package' });
    expect(mls.acquireAddLock).not.toHaveBeenCalled();
    expect(mls.addMembersBulk).not.toHaveBeenCalled();
    expect(lines.some((l) => /published NO KeyPackage/.test(l))).toBe(true);
  });

  it('admits nobody when this device does not hold the group, and says so', async () => {
    mls.getLocalGroups.mockReturnValue([]);

    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(out).toEqual({ kind: 'not-held' });
    expect(mls.fetchUserDevices).not.toHaveBeenCalled();
    expect(mls.addMembersBulk).not.toHaveBeenCalled();
    expect(lines.some((l) => /holds no key group/.test(l))).toBe(true);
  });

  it('commits nothing when every device of the newcomer already holds a leaf', async () => {
    mls.getGroupMemberIdentities.mockResolvedValue(['admin:web-1', 'bob:phone', 'bob:web']);

    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(out).toEqual({ kind: 'already-in-tree' });
    expect(mls.addMembersBulk).not.toHaveBeenCalled();
    expect(mls.sendWelcome).not.toHaveBeenCalled();
    expect(persisted).toBe(0);
    expect(mls.releaseAddLock).toHaveBeenCalled();
  });

  it('adds only the missing device when one already joined by its own door', async () => {
    mls.getGroupMemberIdentities.mockResolvedValue(['admin:web-1', 'bob:web']);
    mls.addMembersBulk.mockResolvedValue({
      welcome: new Uint8Array([9]),
      addedDeviceIds: ['phone'],
      skippedDeviceIds: [],
    });

    await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(mls.addMembersBulk).toHaveBeenCalledWith(
      'key-group',
      [{ deviceId: 'phone', keyPackage: kp(1) }],
      ['bob:phone']
    );
    expect(mls.sendWelcome).toHaveBeenCalledTimes(1);
  });

  it('admits nobody while another admitter holds the add-lock', async () => {
    mls.acquireAddLock.mockResolvedValue(false);

    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(out).toEqual({ kind: 'lock-busy' });
    expect(mls.getGroupMemberIdentities).not.toHaveBeenCalled();
    expect(mls.releaseAddLock).not.toHaveBeenCalled();
  });

  it('re-builds a refused Add on the epoch that beat it, for the devices still without a leaf', async () => {
    // NOTIF-21, 2026-09-28: the newcomer's live web client joined by its own external commit in the
    // same second; the dead phone had no door but this Add.
    let epoch = 5;
    mls.getEpoch.mockImplementation(() => epoch);
    mls.getGroupMemberIdentities
      .mockResolvedValueOnce(['admin:web-1'])
      .mockResolvedValueOnce(['admin:web-1', 'bob:web']);
    mls.addMembersBulk
      .mockImplementationOnce(async () => {
        epoch = 6; // the refusal's catch-up applied the winning external commit
        throw new CommitRefusedError('epoch_mismatch', 5, 6);
      })
      .mockResolvedValueOnce({
        welcome: new Uint8Array([9]),
        ratchetTree: new Uint8Array([8]),
        addedDeviceIds: ['phone'],
        skippedDeviceIds: [],
      });

    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(out).toMatchObject({ kind: 'admitted', deviceIds: ['phone'] });
    expect(mls.addMembersBulk).toHaveBeenCalledTimes(2);
    expect(
      mls.addMembersBulk.mock.calls[1][1].map((d: { deviceId: string }) => d.deviceId)
    ).toEqual(['phone']);
    expect(mls.sendWelcome).toHaveBeenCalledTimes(1);
    expect(mls.releaseAddLock).toHaveBeenCalledTimes(1);
  });

  it('gives up, loudly, on a refusal its catch-up could not move past', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mls.addMembersBulk.mockRejectedValue(new CommitRefusedError('epoch_mismatch', 5, 7));

    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(out).toEqual({ kind: 'failed', stage: 'commit' });
    expect(mls.addMembersBulk).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT admitted'));
    warn.mockRestore();
  });

  it('sends no Welcome and persists nothing when the Add fails for any other cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mls.addMembersBulk.mockRejectedValue(new Error('network down'));

    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(out).toEqual({ kind: 'failed', stage: 'commit' });
    expect(mls.sendWelcome).not.toHaveBeenCalled();
    expect(persisted).toBe(0);
    expect(mls.releaseAddLock).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports devices that could not be READ apart from a newcomer that has none', async () => {
    mls.fetchUserDevices.mockRejectedValue(new Error('503'));

    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(out).toEqual({ kind: 'failed', stage: 'devices' });
    expect(lines.some((l) => /published NO KeyPackage/.test(l))).toBe(false);
  });

  it('keeps Welcoming the other devices when one Welcome is refused', async () => {
    mls.sendWelcome.mockRejectedValueOnce(new Error('404'));

    const out = await admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log);

    expect(mls.sendWelcome).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ kind: 'admitted', deviceIds: ['web'] });
  });

  it('is harmless before a session has wired the Graine runtime', async () => {
    setGraineRuntime(null);

    await expect(
      admitNewcomerToDistributionGroup(workspaceScope('ws-1'), 'bob', log)
    ).resolves.toEqual({ kind: 'no-runtime' });
    expect(mls.addMembersBulk).not.toHaveBeenCalled();
  });
});

describe('the two ways somebody else lets a newcomer in', () => {
  it('an invitation to a PRIVATE salon admits into the community group, then the salon one', async () => {
    await admitInvitedMember('ws-1', 'chan-1', true, 'bob', log);

    expect(mls.distributionGroupFor.mock.calls.map((c) => c[0])).toEqual([
      workspaceScope('ws-1'),
      channelScope('ws-1', 'chan-1'),
    ]);
  });

  it('an invitation to a public salon admits into the community group only', async () => {
    await admitInvitedMember('ws-1', 'chan-1', false, 'bob', log);

    expect(mls.distributionGroupFor.mock.calls.map((c) => c[0])).toEqual([workspaceScope('ws-1')]);
  });

  it("a private-salon grant admits into that salon's own group", async () => {
    registerChannelWorkspace('channel_chan-2', 'ws-1', true);

    await admitSalonGrantee('channel_chan-2', 'bob', log);

    expect(mls.distributionGroupFor).toHaveBeenCalledWith(channelScope('ws-1', 'chan-2'));
  });

  it('a grant in a community this session never loaded admits nobody', async () => {
    await expect(admitSalonGrantee('chan-unknown', 'bob', log)).resolves.toEqual({
      kind: 'not-held',
    });
    expect(mls.distributionGroupFor).not.toHaveBeenCalled();
  });
});
