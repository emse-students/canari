import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/chat/groupSyncEligibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/groupSyncEligibility')>()),
  resolveTerminalGroup: vi.fn().mockResolvedValue({
    terminalId: 'g1',
    groupMeta: { name: 'a::b', isGroup: false, deletedAt: null },
    hasChain: false,
  }),
}));

import { processPendingInvitations } from './actions';

function makeMls(overrides: Partial<IMlsService> = {}): IMlsService {
  return {
    getDeviceId: vi.fn().mockReturnValue('self-device'),
    getLocalGroups: vi.fn().mockReturnValue(['g1']),
    getPendingInvitations: vi.fn().mockResolvedValue([]),
    acquireAddLock: vi.fn().mockResolvedValue(true),
    releaseAddLock: vi.fn().mockResolvedValue(undefined),
    getGroupMembers: vi.fn().mockResolvedValue([]),
    fetchUserDevices: vi.fn().mockResolvedValue([]),
    fetchDeviceKeyPackage: vi.fn().mockResolvedValue(null),
    removeMemberDevice: vi.fn().mockResolvedValue(undefined),
    kickStaleDevice: vi.fn().mockResolvedValue(undefined),
    addMember: vi.fn(),
    updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
    registerMember: vi.fn().mockResolvedValue(undefined),
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    sendCommit: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue(new Uint8Array([1])),
    ...overrides,
  } as unknown as IMlsService;
}

function readyConversation(id: string): Conversation {
  return {
    id,
    contactName: id,
    name: 'a::b',
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
  } as Conversation;
}

describe('processPendingInvitations - leaf already in tree', () => {
  it('skips without kicking or re-adding when device is already a member of the MLS tree', async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'peer', deviceId: 'peer-dev' }]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) }]),
    });
    const conversations = new Map<string, Conversation>([['g1', readyConversation('g1')]]);
    const log = vi.fn();

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      pin: 'pin',
      conversations,
      log,
    });

    // A valid leaf must never be kicked or re-added: the invitation is fulfilled.
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already in tree'));
  });

  it('normally adds a device absent from the tree', async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) }]),
      addMember: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([2]),
        ratchetTree: new Uint8Array([4]),
      }),
    });
    const conversations = new Map<string, Conversation>([['g1', readyConversation('g1')]]);
    const log = vi.fn();

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      pin: 'pin',
      conversations,
      log,
    });

    // addMember now runs the whole staged transaction and takes the commit-broadcast exclude list.
    expect(mlsService.addMember).toHaveBeenCalledWith('g1', expect.any(Uint8Array), [
      'peer:peer-dev',
    ]);
    expect(mlsService.sendWelcome).toHaveBeenCalled();
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
  });
});

describe('processPendingInvitations - staged Add commit outcomes', () => {
  it('does NOT trigger fork recovery when a staged Add commit is rejected (benign retry, C7-A)', async () => {
    // C7-A: a staged Add validates the epoch server-side and rolls back on reject, so the local
    // epoch never advances - there is no fork. The rejection carries a plain `epoch_mismatch`
    // reason WITHOUT the `server epoch:.., sent:..` marker, so it is treated as a transient race to
    // retry on the next cycle, NEVER as a divergent branch needing destructive recovery.
    const mlsService = makeMls({
      getPendingInvitations: vi.fn().mockResolvedValue([
        { id: 'i1', userId: 'peer', deviceId: 'peer-dev-1', groupId: 'g1', status: 'pending' },
        { id: 'i2', userId: 'peer', deviceId: 'peer-dev-2', groupId: 'g1', status: 'pending' },
      ]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      getDeviceMemberships: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi.fn().mockResolvedValue([
        { deviceId: 'peer-dev-1', keyPackage: new Uint8Array([1]) },
        { deviceId: 'peer-dev-2', keyPackage: new Uint8Array([1]) },
      ]),
      addMember: vi.fn().mockRejectedValue(new Error('Staged commit rejected: epoch_mismatch')),
    });
    const conversations = new Map<string, Conversation>([['g1', readyConversation('g1')]]);
    const log = vi.fn();
    const recoverForkedGroup = vi.fn().mockResolvedValue(undefined);

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      pin: 'pin',
      conversations,
      log,
      recoverForkedGroup,
    });

    // No destructive fork recovery, and the group is not abandoned: both invitations are still
    // attempted (a benign reject just retries next cycle).
    expect(recoverForkedGroup).not.toHaveBeenCalled();
    expect(mlsService.addMember).toHaveBeenCalledTimes(2);
  });

  it('treats ALREADY_MEMBER as a fulfilled invitation (skip, no kick or recovery)', async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev-1', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev-1', keyPackage: new Uint8Array([1]) }]),
      addMember: vi
        .fn()
        .mockRejectedValue(
          new Error('ALREADY_MEMBER: All KeyPackages already belong to existing group members')
        ),
    });
    const conversations = new Map<string, Conversation>([['g1', readyConversation('g1')]]);
    const log = vi.fn();
    const recoverForkedGroup = vi.fn().mockResolvedValue(undefined);

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      pin: 'pin',
      conversations,
      log,
      recoverForkedGroup,
    });

    expect(recoverForkedGroup).not.toHaveBeenCalled();
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invitation fulfilled'));
    // The fulfilled invitation is promoted to active so the server stops re-serving it.
    expect(mlsService.updateInvitationStatus).toHaveBeenCalledWith(
      'peer-dev-1',
      'peer',
      'g1',
      'active'
    );
  });
});
