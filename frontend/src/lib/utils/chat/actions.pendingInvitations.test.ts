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
    getGroupMemberIdentities: vi.fn().mockResolvedValue([]),
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
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['peer:peer-dev']),
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
      deviceKeyB64: 'pin',
      conversations,
      requestReAdd: () => Promise.resolve(),
      log,
    });

    // A valid leaf must never be kicked or re-added: the invitation is fulfilled.
    expect(mlsService.removeMemberDevice).not.toHaveBeenCalled();
    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already in tree'));
    // AND THE ROUTING TABLE IS NEVER ASKED. It answers a different question, and this one is local.
    expect(mlsService.getGroupMembers).not.toHaveBeenCalled();
  });

  // THE DEFECT THIS PINS, and the reason the two sources cannot be swapped for one another: a
  // device fresh-start clears its routing rows while the ratchet tree stays full. Read the routing
  // table and you get "not a member" of a leaf sitting right there, so the Add goes out and OpenMLS
  // declines it - `[RUST::WARN] Skipping KeyPackage already a member of the group`, seen on GRP-5
  // (2026-08-23) and GRP-3 (2026-08-24) and mistaken for a flake both times.
  it('skips a leaf the tree holds even when the routing table has lost its row', async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:peer-dev']),
      // Empty, as a fresh-start leaves it. The old check read THIS and re-added over a live leaf.
      getGroupMembers: vi.fn().mockResolvedValue([]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) }]),
    });
    const log = vi.fn();

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: new Map([['g1', readyConversation('g1')]]),
      requestReAdd: () => Promise.resolve(),
      log,
    });

    expect(mlsService.addMember).not.toHaveBeenCalled();
  });

  // The converse divergence, which is the stale `pending` row: the server still lists a device it
  // never got into the tree. The invitation is NOT fulfilled and must be honoured - a check that
  // read the routing table would have skipped it and left the device outside forever.
  it('adds a device the routing table lists but the tree does not hold', async () => {
    const addMember = vi
      .fn()
      .mockResolvedValue({ welcome: new Uint8Array([9]), ratchetTree: null });
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device']),
      getGroupMembers: vi.fn().mockResolvedValue([{ userId: 'peer', deviceId: 'peer-dev' }]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) }]),
      addMember,
    });

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: new Map([['g1', readyConversation('g1')]]),
      requestReAdd: () => Promise.resolve(),
      log: vi.fn(),
    });

    expect(addMember).toHaveBeenCalled();
  });

  // A LEAF IS `userId:deviceId` AND THE WHOLE OF IT IS THE KEY. Two users can hold the same device
  // id - it is client-generated - so a suffix or substring test would let one answer for the other
  // and silently drop a real invitation.
  it('does not let another user leaf answer for this one', async () => {
    const addMember = vi
      .fn()
      .mockResolvedValue({ welcome: new Uint8Array([9]), ratchetTree: null });
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['someone-else:peer-dev']),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) }]),
      addMember,
    });

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: new Map([['g1', readyConversation('g1')]]),
      requestReAdd: () => Promise.resolve(),
      log: vi.fn(),
    });

    expect(addMember).toHaveBeenCalled();
  });

  // THREE ANSWERS, AND THE THIRD IS NOT A "NO". An unreadable tree falls through to the Add exactly
  // as the swallowed `catch` here used to - but it says so first, which is the whole change: this
  // branch was the one place a lost group could hide.
  it('falls through to the add on an unreadable tree, and logs that it could not tell', async () => {
    const addMember = vi
      .fn()
      .mockResolvedValue({ welcome: new Uint8Array([9]), ratchetTree: null });
    const mlsService = makeMls({
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev', groupId: 'g1', status: 'pending' },
        ]),
      getGroupMemberIdentities: vi.fn().mockRejectedValue(new Error('GroupNotFound')),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'peer-dev', keyPackage: new Uint8Array([1]) }]),
      addMember,
    });
    const log = vi.fn();

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: new Map([['g1', readyConversation('g1')]]),
      requestReAdd: () => Promise.resolve(),
      log,
    });

    expect(addMember).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Tree of g1'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('GroupNotFound'));
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
      deviceKeyB64: 'pin',
      conversations,
      requestReAdd: () => Promise.resolve(),
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

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations,
      requestReAdd: () => Promise.resolve(),
      log,
    });

    // The group is not abandoned: both invitations are still attempted (a benign reject just
    // retries next cycle).
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

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations,
      requestReAdd: () => Promise.resolve(),
      log,
    });

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

// THE PASS CAN DISCOVER THAT **THIS** DEVICE IS THE ONE MISSING, and what it does then used to
// bypass the ladder entirely: a bare `sendWelcomeRequest`, which asks a member for something the
// device can very often serve itself, races that member's in-flight Add, and is subject to no
// throttle on a pass that runs on every connection.
describe('processPendingInvitations - the group is absent from THIS device', () => {
  function absentLocally() {
    return makeMls({
      // No local state for g1, and no conversation record either - the `isAbsent` branch.
      getLocalGroups: vi.fn().mockReturnValue([]),
      getPendingInvitations: vi
        .fn()
        .mockResolvedValue([
          { id: 'i1', userId: 'peer', deviceId: 'peer-dev', groupId: 'g1', status: 'pending' },
        ]),
      // Present and live on the server: the group exists, we simply hold nothing for it.
      getUserGroups: vi.fn().mockResolvedValue([{ groupId: 'g1', deletedAt: null }]),
      sendWelcomeRequest: vi.fn().mockResolvedValue(undefined),
      deleteDeviceMembership: vi.fn().mockResolvedValue(undefined),
    });
  }

  it('drives the single recovery seam and never asks a member directly', async () => {
    const mlsService = absentLocally();
    const requestReAdd = vi.fn().mockResolvedValue(undefined);

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: new Map<string, Conversation>(),
      requestReAdd,
      log: vi.fn(),
    });

    expect(requestReAdd).toHaveBeenCalledWith('g1');
    expect(mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
  });

  // A rejected recovery must not take the invitation pass down with it: the remaining groups still
  // have to be processed, and the watchdog re-drives this one on its own cadence.
  it('logs and continues when the seam rejects', async () => {
    const mlsService = absentLocally();
    const log = vi.fn();

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: new Map<string, Conversation>(),
      requestReAdd: () => Promise.reject(new Error('offline')),
      log,
    });

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('recovery requested'))).toBe(true);
    expect(lines.some((l) => l.includes('recovery request failed'))).toBe(true);
  });

  // The opposite answer, and the one that must NOT reach recovery: the server says the group is
  // gone, so the invitations are residue to delete rather than a group to rejoin.
  it('cleans up the invitations instead when the server says the group is gone', async () => {
    const mlsService = absentLocally();
    (mlsService.getUserGroups as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const requestReAdd = vi.fn().mockResolvedValue(undefined);

    await processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: new Map<string, Conversation>(),
      requestReAdd,
      log: vi.fn(),
    });

    expect(requestReAdd).not.toHaveBeenCalled();
    expect(mlsService.deleteDeviceMembership).toHaveBeenCalledWith('peer', 'peer-dev', 'g1');
  });
});
