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
        commit: new Uint8Array([3]),
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

    expect(mlsService.addMember).toHaveBeenCalledWith('g1', expect.any(Uint8Array));
    expect(mlsService.sendWelcome).toHaveBeenCalled();
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
  });
});

describe('processPendingInvitations - local state forked behind server', () => {
  it('triggers recoverForkedGroup and abandons the group when commit is rejected (gap > 1)', async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi.fn().mockResolvedValue([
        { id: 'i1', userId: 'peer', deviceId: 'peer-dev-1', groupId: 'g1', status: 'pending' },
        { id: 'i2', userId: 'peer', deviceId: 'peer-dev-2', groupId: 'g1', status: 'pending' },
      ]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi.fn().mockResolvedValue([
        { deviceId: 'peer-dev-1', keyPackage: new Uint8Array([1]) },
        { deviceId: 'peer-dev-2', keyPackage: new Uint8Array([1]) },
      ]),
      addMember: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([2]),
        commit: new Uint8Array([3]),
        ratchetTree: new Uint8Array([4]),
      }),
      sendCommit: vi
        .fn()
        .mockRejectedValue(
          new Error('Commit rejected: epoch_mismatch (server epoch: 23, sent: 7)')
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

    // Recovery triggered once for the group, and the 2nd invitation is not attempted
    // (break on forked group): addMember called only once.
    expect(recoverForkedGroup).toHaveBeenCalledTimes(1);
    expect(recoverForkedGroup).toHaveBeenCalledWith('g1', 23);
    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
  });

  it('triggers recovery at a gap of 1 when OUR commit is rejected (sender concurrent fork, C7)', async () => {
    // On the sender side, addMember has already merged the commit locally (epoch N+1) before
    // the server rejects it: a gap of 1 is a real concurrent fork (divergent branch), not a
    // simple receiver lag. Must recover, otherwise the winning commit is dropped as same-epoch
    // benign and the fork becomes permanent.
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev-1', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMembers: vi.fn().mockResolvedValue([]),
      getDeviceMemberships: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev-1', keyPackage: new Uint8Array([1]) }]),
      addMember: vi.fn().mockResolvedValue({
        welcome: new Uint8Array([2]),
        commit: new Uint8Array([3]),
        ratchetTree: new Uint8Array([4]),
      }),
      sendCommit: vi
        .fn()
        .mockRejectedValue(new Error('Commit rejected: epoch_mismatch (server epoch: 8, sent: 7)')),
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

    expect(recoverForkedGroup).toHaveBeenCalledTimes(1);
    expect(recoverForkedGroup).toHaveBeenCalledWith('g1', 8);
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
