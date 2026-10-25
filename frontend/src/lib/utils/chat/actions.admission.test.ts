// @vitest-environment happy-dom
/**
 * THE EMISSION HALF OF THE ADMISSION POLICY: no AUTOMATIC Add brings a new user into a group.
 *
 * Both automatic adders - the pending-invitation sweep and the `welcome_request` handler - act on
 * what the server says: a `pending` row, a `dm_group_members` row, a relayed request. A server under
 * hostile control writes all three. So the one question that decides an automatic Add is answered
 * from THIS device's own MLS tree: does the requester's USER already hold a leaf? If yes, this is a
 * new or recovering device of a member and the Add proceeds. If no, the Add is a decision about a
 * new person, and it belongs to a human: the join is surfaced for a member to approve
 * (`onJoinApprovalRequested`), and only that member's own explicit Add brings them in.
 *
 * A tree this device cannot read proves nothing, so it refuses (fail-closed): another member, or
 * the next sweep, answers.
 */
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import {
  handleWelcomeRequest,
  processPendingInvitations,
  type JoinApprovalRequest,
} from './actions';
import { resetWelcomeSent } from './welcomeSent';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

function activeConversations(
  groupId: string,
  conversationType?: Conversation['conversationType']
): Map<string, Conversation> {
  return new Map([
    [
      groupId,
      {
        id: groupId,
        contactName: groupId,
        name: 'Test',
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
        ...(conversationType ? { conversationType } : {}),
      } as Conversation,
    ],
  ]);
}

beforeEach(() => resetWelcomeSent());

// ── welcome_request ──────────────────────────────────────────────────────────

describe('handleWelcomeRequest - a new user is never added automatically', () => {
  /** A server that vouches for the requester everywhere it can: roster row, KeyPackage. */
  const serverVouches = (overrides: Partial<IMlsService> = {}) =>
    createMlsServiceStub({
      getGroupMeta: vi.fn().mockResolvedValue({ name: 'Test', isGroup: true }),
      getGroupUserMembers: vi
        .fn()
        // `stranger` holds an invitation link's seat: the server names it an ask.
        .mockResolvedValue([
          { userId: 'me' },
          { userId: 'peer' },
          { userId: 'stranger', awaitingAdmission: true },
        ]),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([{ deviceId: 'dev-1', keyPackage: new Uint8Array([7]) }]),
      addMember: vi
        .fn()
        .mockResolvedValue({ welcome: new Uint8Array([1]), ratchetTree: new Uint8Array([2]) }),
      ...overrides,
    });

  const run = (
    groupId: string,
    mlsService: ReturnType<typeof createMlsServiceStub>,
    requesterUserId: string,
    extra: {
      log?: (msg: string) => void;
      onJoinApprovalRequested?: (request: JoinApprovalRequest) => void;
      conversationType?: Conversation['conversationType'];
    } = {}
  ) =>
    handleWelcomeRequest({
      mlsService,
      storage: null,
      userId: 'me',
      deviceKeyB64: 'pin',
      conversations: activeConversations(groupId, extra.conversationType),
      log: extra.log ?? vi.fn(),
      requesterUserId,
      requesterDeviceId: 'dev-1',
      groupId,
      onJoinApprovalRequested: extra.onJoinApprovalRequested,
    });

  it('does not add a user the server lists but the local tree has never held', async () => {
    // The compromised-server case exactly: roster row written, request relayed, KeyPackage served.
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:p1']),
    });

    await run('g-adm-stranger', mlsService, 'stranger');

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(mlsService.registerMember).not.toHaveBeenCalled();
  });

  it('asks a member to approve the join instead (the invitation link)', async () => {
    const onJoinApprovalRequested = vi.fn();
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:p1']),
    });

    await run('g-adm-approval', mlsService, 'stranger', { onJoinApprovalRequested });

    expect(onJoinApprovalRequested).toHaveBeenCalledTimes(1);
    expect(onJoinApprovalRequested).toHaveBeenCalledWith({
      groupId: 'g-adm-approval',
      requesterUserId: 'stranger',
      requesterDeviceId: 'dev-1',
    });
    expect(mlsService.addMember).not.toHaveBeenCalled();
  });

  it("asks nobody about a person whose seat is not an invitation link's ask", async () => {
    // A member's invite between its roster write and its Add, or a seat older than the rule: the
    // server does not name it an ask, so nobody is asked in that person's name - and a Decline would
    // have found nothing to withdraw.
    const onJoinApprovalRequested = vi.fn();
    const log = vi.fn();
    const mlsService = serverVouches({
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'me' }, { userId: 'stranger' }]),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self']),
    });

    await run('g-adm-not-an-ask', mlsService, 'stranger', { onJoinApprovalRequested, log });

    expect(onJoinApprovalRequested).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not an invitation-link ask'));
  });

  it('asks nobody about a 1:1 conversation or a channel - only a group takes a join ask', async () => {
    // A DM's `pending` rows are written for every group of a registering user: a peer holding no
    // leaf there raised an ask whose Add always failed and whose Decline deleted the peer's DM row.
    for (const conversationType of ['direct', 'channel'] as const) {
      const onJoinApprovalRequested = vi.fn();
      const log = vi.fn();
      const mlsService = serverVouches({
        getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self']),
      });

      await run(`g-adm-${conversationType}`, mlsService, 'stranger', {
        onJoinApprovalRequested,
        log,
        conversationType,
      });

      expect(onJoinApprovalRequested).not.toHaveBeenCalled();
      expect(mlsService.addMember).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('takes no join ask'));
    }
  });

  it('says in the log which user it refused and why', async () => {
    const log = vi.fn();
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self']),
    });

    await run('g-adm-log', mlsService, 'stranger', { log });

    const said = log.mock.calls.flat().join(' ');
    expect(said).toContain('stranger');
    expect(said).toContain('no leaf');
  });

  it('adds a new device of a user who already holds a leaf', async () => {
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:old-phone']),
    });

    await run('g-adm-new-device', mlsService, 'peer');

    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
  });

  it('does not let a leaf of ANOTHER user with the same device id answer for the requester', async () => {
    // A leaf is `userId:deviceId` and device ids are client-generated: `peer:dev-1` says nothing
    // about `stranger`.
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:dev-1']),
    });

    await run('g-adm-same-device-id', mlsService, 'stranger');

    expect(mlsService.addMember).not.toHaveBeenCalled();
  });

  it('refuses on a tree it cannot read - an unreadable tree proves no membership', async () => {
    const onJoinApprovalRequested = vi.fn();
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockRejectedValue(new Error('GroupNotFound')),
    });

    await run('g-adm-unreadable', mlsService, 'peer', { onJoinApprovalRequested });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    // Not a join to approve either: nothing says the requester is new, only that we cannot tell.
    expect(onJoinApprovalRequested).not.toHaveBeenCalled();
  });

  it('still refuses a user the server has removed, whatever the tree says', async () => {
    // The existing roster guard stays: both conditions are required, neither replaces the other.
    const mlsService = serverVouches({
      getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'me' }]),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:old-phone']),
    });

    await run('g-adm-removed', mlsService, 'peer');

    expect(mlsService.addMember).not.toHaveBeenCalled();
  });
});

// ── pending-invitation sweep ─────────────────────────────────────────────────

describe('processPendingInvitations - a new user is never added automatically', () => {
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
      fetchDeviceKeyPackage: vi.fn().mockResolvedValue({ kind: 'none', reason: 'unregistered' }),
      removeMemberDevice: vi.fn().mockResolvedValue(undefined),
      kickStaleDevice: vi.fn().mockResolvedValue(undefined),
      addMember: vi.fn().mockResolvedValue({ welcome: new Uint8Array([2]), ratchetTree: null }),
      updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
      deleteDeviceMembership: vi.fn().mockResolvedValue(undefined),
      registerMember: vi.fn().mockResolvedValue(undefined),
      sendWelcome: vi.fn().mockResolvedValue(undefined),
      sendCommit: vi.fn().mockResolvedValue(undefined),
      // The tree an Add's premise is re-read from (`confirmPendingAddPremise`): at the server's epoch.
      getEpoch: vi.fn().mockReturnValue(0),
      fetchCommitsSince: vi
        .fn()
        .mockResolvedValue({ commits: [], activeEpoch: 0, belowFloor: false }),
      runUnderMlsLock: vi.fn((fn: () => Promise<unknown>) => fn()),
      ...overrides,
    } as unknown as IMlsService;
  }

  /**
   * A `pending` row for `userId:deviceId` in g1, with a KeyPackage served for it - an invitation
   * link's ask unless `awaitingAdmission` says otherwise.
   */
  const pendingFor = (userId: string, deviceId: string, awaitingAdmission = true) => ({
    getPendingInvitations: vi
      .fn()
      .mockResolvedValue([
        { id: 'i1', userId, deviceId, groupId: 'g1', status: 'pending', awaitingAdmission },
      ]),
    fetchUserDevices: vi.fn().mockResolvedValue([{ deviceId, keyPackage: new Uint8Array([1]) }]),
  });

  const sweep = (
    mlsService: IMlsService,
    extra: {
      log?: (msg: string) => void;
      onJoinApprovalRequested?: (request: JoinApprovalRequest) => void;
      conversations?: Map<string, Conversation>;
    } = {}
  ) =>
    processPendingInvitations({
      mlsService,
      storage: null,
      userId: 'self',
      deviceKeyB64: 'pin',
      conversations: extra.conversations ?? activeConversations('g1'),
      requestReAdd: () => Promise.resolve(),
      log: extra.log ?? vi.fn(),
      onJoinApprovalRequested: extra.onJoinApprovalRequested,
    });

  it('does not add a pending device whose user holds no leaf in the local tree', async () => {
    // One INSERT on the server is all this takes today: a `pending` row, and every online member
    // builds the Add and the Welcome for it.
    const mlsService = makeMls({
      ...pendingFor('stranger', 's1'),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:p1']),
    });

    await sweep(mlsService);

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
  });

  it('keeps the row and asks a member to approve - refusing is not retiring', async () => {
    // The row may be a legitimate join from the invitation link: it is left for the approval, never
    // deleted on the strength of a policy this device applied.
    const onJoinApprovalRequested = vi.fn();
    const mlsService = makeMls({
      ...pendingFor('stranger', 's1'),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device']),
    });

    await sweep(mlsService, { onJoinApprovalRequested });

    expect(onJoinApprovalRequested).toHaveBeenCalledWith({
      groupId: 'g1',
      requesterUserId: 'stranger',
      requesterDeviceId: 's1',
    });
    expect(mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
    expect(mlsService.updateInvitationStatus).not.toHaveBeenCalled();
  });

  it('raises no ask for a pending row the server does not name an ask, and leaves it alone', async () => {
    const onJoinApprovalRequested = vi.fn();
    const log = vi.fn();
    const mlsService = makeMls({
      ...pendingFor('stranger', 's1', false),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device']),
    });

    await sweep(mlsService, { onJoinApprovalRequested, log });

    expect(onJoinApprovalRequested).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not an invitation-link ask'));
  });

  it('raises no ask for a 1:1 conversation, and leaves its row alone', async () => {
    const onJoinApprovalRequested = vi.fn();
    const mlsService = makeMls({
      ...pendingFor('stranger', 's1'),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device']),
    });

    await sweep(mlsService, {
      onJoinApprovalRequested,
      conversations: activeConversations('g1', 'direct'),
    });

    expect(onJoinApprovalRequested).not.toHaveBeenCalled();
    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
  });

  it('adds a pending device of a user who already holds a leaf', async () => {
    const mlsService = makeMls({
      ...pendingFor('peer', 'new-phone'),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']),
    });

    await sweep(mlsService);

    expect(mlsService.addMember).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ userId: 'peer', deviceId: 'new-phone' }),
      ['peer:new-phone']
    );
  });

  it('refuses on a tree it cannot read, and keeps the row for the next sweep', async () => {
    const log = vi.fn();
    const mlsService = makeMls({
      ...pendingFor('peer', 'new-phone'),
      getGroupMemberIdentities: vi.fn().mockRejectedValue(new Error('GroupNotFound')),
    });

    await sweep(mlsService, { log });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('GroupNotFound'));
  });

  it('judges each pending row on its own user: one admissible row does not carry another', async () => {
    const mlsService = makeMls({
      getPendingInvitations: vi.fn().mockResolvedValue([
        { id: 'i1', userId: 'peer', deviceId: 'new-phone', groupId: 'g1', status: 'pending' },
        { id: 'i2', userId: 'stranger', deviceId: 's1', groupId: 'g1', status: 'pending' },
      ]),
      fetchUserDevices: vi
        .fn()
        .mockImplementation(async (userId: string) =>
          userId === 'peer'
            ? [{ deviceId: 'new-phone', keyPackage: new Uint8Array([1]) }]
            : [{ deviceId: 's1', keyPackage: new Uint8Array([3]) }]
        ),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']),
    });

    await sweep(mlsService);

    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(mlsService.addMember).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ userId: 'peer', deviceId: 'new-phone' }),
      ['peer:new-phone']
    );
  });
});
