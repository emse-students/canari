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
  raiseAnnouncedJoinAsk,
  type JoinApprovalRequest,
} from './actions';
import {
  pendingJoinRequests,
  raiseJoinRequest,
  resetJoinRequests,
  settleJoinRequest,
} from './joinRequests.svelte';
import { resetWelcomeSent } from './welcomeSent';
import {
  approveMemberDevice,
  declineMemberDevice,
  memberDeviceAnswer,
  resetMemberDeviceAnswers,
} from './memberDeviceAnswers';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

// The packages below are one opaque byte; the key they carry is read through this seam - `fp-<byte>`
// - so a test can serve a device under one key or another (`deviceTrust.keyPackage.realWasm.test.ts`
// holds the real parser to the WASM build).
vi.mock('$lib/mls-client/deviceTrust', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/deviceTrust')>()),
  keyPackageFingerprintOf: vi.fn(async (keyPackage: Uint8Array) => `fp-${keyPackage[0]}`),
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

beforeEach(() => {
  resetWelcomeSent();
  resetMemberDeviceAnswers();
});

/**
 * A pin for every device in `seen` - a key this device met in SOME merged commit or joined tree,
 * another group's included. It never makes a device "seen" for an admission.
 */
const pinsFor = (...seen: string[]) =>
  vi.fn(async (userId: string, deviceId: string) =>
    seen.includes(`${userId}:${deviceId}`)
      ? { keys: [new Uint8Array([9])], anchored: true, reaffirmations: 0 }
      : null
  );

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
          { userId: 'stranger', awaitingAdmission: true, askId: 'ask-stranger' },
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
    // The ask carries its identity, the seat's id, so an ask the server settled is never raised again.
    expect(onJoinApprovalRequested).toHaveBeenCalledWith({
      groupId: 'g-adm-approval',
      requesterUserId: 'stranger',
      requesterDeviceId: 'dev-1',
      askId: 'ask-stranger',
    });
    expect(mlsService.addMember).not.toHaveBeenCalled();
  });

  it("never raises a person's ask for a user who already holds a leaf, whatever the seat's flag", async () => {
    // The ask's Add re-plans the person's devices from the server's list and its Decline removes
    // their leaves: one tap on it would act on a member nobody asked about (review of #2594).
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onJoinApprovalRequested = vi.fn();
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:p1', 'stranger:old']),
    });

    await run('g-adm-leaf', mlsService, 'stranger', { onJoinApprovalRequested });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.replaceMember).not.toHaveBeenCalled();
    expect(onJoinApprovalRequested).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('the user already holds a leaf there - no person')
    );
    error.mockRestore();
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

  it("re-admits a device whose own leaf is in THIS group's tree (a lost state), in one commit", async () => {
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:dev-1']),
    });

    await run('g-adm-own-leaf', mlsService, 'peer');

    expect(mlsService.replaceMember).toHaveBeenCalledTimes(1);
  });

  it('a pin of the device from ANOTHER group is not "seen" here - it is asked about, not added', async () => {
    // Pins are one store for every group: a key met in another group, a key group or a device's own
    // external entry. None of it says a member of THIS group admitted the device.
    const onJoinApprovalRequested = vi.fn();
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:old-phone']),
      pinnedSignatureKeys: pinsFor('peer:dev-1'),
    });

    await run('g-adm-pinned-elsewhere', mlsService, 'peer', { onJoinApprovalRequested });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(onJoinApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ requesterDeviceId: 'dev-1', kind: 'device' })
    );
  });

  it('asks about a device of a member it never saw, showing its key, and adds nothing', async () => {
    // A leaf of `peer` proves the user, not `dev-1`: its first admission is a member's gesture.
    const onJoinApprovalRequested = vi.fn();
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:old-phone']),
      fetchUserDevices: vi
        .fn()
        .mockResolvedValue([
          { deviceId: 'dev-1', deviceName: 'Pixel', keyPackage: new Uint8Array([7]) },
        ]),
    });

    await run('g-adm-unseen', mlsService, 'peer', { onJoinApprovalRequested });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.replaceMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(onJoinApprovalRequested).toHaveBeenCalledWith({
      groupId: 'g-adm-unseen',
      requesterUserId: 'peer',
      requesterDeviceId: 'dev-1',
      kind: 'device',
      keyFingerprint: 'fp-7',
      deviceLabel: 'Pixel',
    });
  });

  it('says the ask about an unseen device ONCE per decision, and again when the epoch, the key or the shown ask moves', async () => {
    // DEVREVOKE-KEYGROUP (2026-10-29): two passes of the same request printed the same decision twice.
    resetJoinRequests();
    const lines: string[] = [];
    const log = (msg: string) => lines.push(msg);
    const onJoinApprovalRequested = vi.fn((ask: JoinApprovalRequest) => raiseJoinRequest(ask));
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:old-phone']),
    });
    const asked = () => lines.filter((l) => l.includes('is a device this one never saw')).length;

    await run('g-adm-once', mlsService, 'peer', { onJoinApprovalRequested, log });
    await run('g-adm-once', mlsService, 'peer', { onJoinApprovalRequested, log });
    expect(asked()).toBe(1);
    // Still RAISED every time: a sweep keeps only what it raised.
    expect(onJoinApprovalRequested).toHaveBeenCalledTimes(2);
    expect(pendingJoinRequests()).toHaveLength(1);

    // A roster change moved the epoch: decided again, said again.
    vi.mocked(mlsService.getEpoch).mockReturnValue(4);
    await run('g-adm-once', mlsService, 'peer', { onJoinApprovalRequested, log });
    expect(asked()).toBe(2);

    // The ask left the screen (answered elsewhere, a sweep, a reset): never stranded, asked again.
    resetJoinRequests();
    await run('g-adm-once', mlsService, 'peer', { onJoinApprovalRequested, log });
    expect(asked()).toBe(3);
    expect(pendingJoinRequests()).toHaveLength(1);
    resetJoinRequests();
  });

  it('forgets the decisions said about unseen devices at sign-out', async () => {
    // The record is the leaving account's: the next account's first decision must be said in full.
    // `useMessaging` resets it next to its other leaving-account records.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'src', 'lib', 'composables', 'useMessaging.svelte.ts'),
      'utf8'
    );
    expect(src).toContain('resetUnseenDeviceDecisions();');
  });

  it("asks about the account's OWN unseen device the same way", async () => {
    const onJoinApprovalRequested = vi.fn();
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:p1']),
    });

    await run('g-adm-own-unseen', mlsService, 'me', { onJoinApprovalRequested });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(onJoinApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ requesterUserId: 'me', kind: 'device' })
    );
  });

  it('adds an unseen device once this member approved it under the key it is served with', async () => {
    const approved = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:old-phone']),
    });
    approveMemberDevice('peer', 'dev-1', 'fp-7');
    await run('g-adm-approved', approved, 'peer');
    expect(approved.addMember).toHaveBeenCalledTimes(1);
  });

  it('refuses an approved device served under ANOTHER key, withdraws the approval and asks anew', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mlsService = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:old-phone']),
    });
    // Approved under key `fp-3`; the server now serves a package carrying `fp-7`.
    approveMemberDevice('peer', 'dev-1', 'fp-3');

    await run('g-adm-swapped-key', mlsService, 'peer');

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(memberDeviceAnswer('g-adm-swapped-key', 'peer', 'dev-1')).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not the approved fp-3'));
    error.mockRestore();
  });

  it('never asks again about a device it declined in that conversation - and still asks in another', async () => {
    declineMemberDevice('g-adm-declined', 'peer', 'dev-1');
    const onJoinApprovalRequested = vi.fn();
    const declined = serverVouches({
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['me:self', 'peer:old-phone']),
    });
    await run('g-adm-declined', declined, 'peer', { onJoinApprovalRequested });
    expect(declined.addMember).not.toHaveBeenCalled();
    expect(onJoinApprovalRequested).not.toHaveBeenCalled();

    await run('g-adm-elsewhere', declined, 'peer', { onJoinApprovalRequested });
    expect(onJoinApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g-adm-elsewhere', kind: 'device' })
    );
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

  it('a pending device of a member pinned from ANOTHER group is asked about, never added', async () => {
    const onJoinApprovalRequested = vi.fn();
    const mlsService = makeMls({
      ...pendingFor('peer', 'new-phone', false),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']),
      pinnedSignatureKeys: pinsFor('peer:new-phone'),
    });

    await sweep(mlsService, { onJoinApprovalRequested });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(onJoinApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ requesterDeviceId: 'new-phone', kind: 'device' })
    );
  });

  it('asks about a pending device of a member it never saw - no Add, no Welcome, ONE package read per session', async () => {
    // A pending row (not an ask) names a device id this device never saw: the member's leaf proves
    // the user, not this device.
    const onJoinApprovalRequested = vi.fn();
    const mlsService = makeMls({
      ...pendingFor('peer', 'never-seen', false),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']),
    });

    await sweep(mlsService, { onJoinApprovalRequested });
    await sweep(mlsService, { onJoinApprovalRequested });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
    expect(mlsService.registerMember).not.toHaveBeenCalled();
    // The key the ask shows is read once and kept: a sweep spends no package per pass.
    expect(mlsService.fetchUserDevices).toHaveBeenCalledTimes(1);
    expect(mlsService.fetchDeviceKeyPackage).not.toHaveBeenCalled();
    expect(onJoinApprovalRequested).toHaveBeenCalledWith({
      groupId: 'g1',
      requesterUserId: 'peer',
      requesterDeviceId: 'never-seen',
      kind: 'device',
      keyFingerprint: 'fp-1',
    });
    // The row is the server's and stays: the member's answer, or the next sweep, settles it.
    expect(mlsService.deleteDeviceMembership).not.toHaveBeenCalled();
    expect(mlsService.updateInvitationStatus).not.toHaveBeenCalled();
  });

  it('asks about an unseen device in a 1:1 conversation too - the answer touches no seat', async () => {
    const onJoinApprovalRequested = vi.fn();
    const mlsService = makeMls({
      ...pendingFor('peer', 'never-seen', false),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']),
    });

    await sweep(mlsService, {
      onJoinApprovalRequested,
      conversations: activeConversations('g1', 'direct'),
    });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(onJoinApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'device' })
    );
  });

  it('two unseen devices of one member are asked about one by one, each under its own key', async () => {
    const onJoinApprovalRequested = vi.fn();
    const mlsService = makeMls({
      getPendingInvitations: vi.fn().mockResolvedValue([
        { id: 'i1', userId: 'peer', deviceId: 'phone', groupId: 'g1', status: 'pending' },
        { id: 'i2', userId: 'peer', deviceId: 'laptop', groupId: 'g1', status: 'pending' },
      ]),
      fetchUserDevices: vi.fn().mockResolvedValue([
        { deviceId: 'phone', keyPackage: new Uint8Array([1]) },
        { deviceId: 'laptop', keyPackage: new Uint8Array([3]) },
      ]),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']),
    });

    await sweep(mlsService, { onJoinApprovalRequested });

    expect(
      onJoinApprovalRequested.mock.calls.map(([r]) => [r.requesterDeviceId, r.keyFingerprint])
    ).toEqual([
      ['phone', 'fp-1'],
      ['laptop', 'fp-3'],
    ]);

    // One approval admits that one device; the other is still asked about.
    approveMemberDevice('peer', 'phone', 'fp-1');
    onJoinApprovalRequested.mockClear();
    await sweep(mlsService, { onJoinApprovalRequested });
    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(mlsService.addMember).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ deviceId: 'phone' }),
      ['peer:phone']
    );
    expect(onJoinApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ requesterDeviceId: 'laptop', kind: 'device' })
    );
  });

  it('adds an unseen device once this member approved it', async () => {
    approveMemberDevice('peer', 'never-seen', 'fp-1');
    const mlsService = makeMls({
      ...pendingFor('peer', 'never-seen', false),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']),
    });

    await sweep(mlsService);

    expect(mlsService.addMember).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ userId: 'peer', deviceId: 'never-seen' }),
      ['peer:never-seen']
    );
  });

  it("a seat flagged as an ask for a user who holds a leaf raises no person's ask and adds nothing", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onJoinApprovalRequested = vi.fn();
    const mlsService = makeMls({
      ...pendingFor('peer', 'new-phone'),
      getGroupMemberIdentities: vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']),
    });

    await sweep(mlsService, { onJoinApprovalRequested });

    expect(mlsService.addMember).not.toHaveBeenCalled();
    expect(onJoinApprovalRequested).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('flagged as a join ask'));
    error.mockRestore();
  });

  it("accuses the flagged seat once a session, and raises the person's ask once the leaf is gone", async () => {
    // A removed member's leaf can outlive the removal until it is collected: every sweep meets the
    // seat again, which is expected and said once. The verdict is read off the tree on every pass, so
    // the ask a member owes the person comes back the moment the leaf is no longer there.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onJoinApprovalRequested = vi.fn();
    const log = vi.fn();
    const identities = vi.fn().mockResolvedValue(['self:self-device', 'peer:old-phone']);
    const mlsService = makeMls({
      ...pendingFor('peer', 'new-phone'),
      getGroupMemberIdentities: identities,
    });

    await sweep(mlsService, { onJoinApprovalRequested, log });
    await sweep(mlsService, { onJoinApprovalRequested, log });

    expect(
      error.mock.calls.filter(([m]) => String(m).includes('flagged as a join ask'))
    ).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already reported this session'));
    expect(onJoinApprovalRequested).not.toHaveBeenCalled();

    identities.mockResolvedValue(['self:self-device']);
    await sweep(mlsService, { onJoinApprovalRequested, log });

    expect(onJoinApprovalRequested).toHaveBeenCalledWith(
      expect.objectContaining({ requesterUserId: 'peer', requesterDeviceId: 'new-phone' })
    );
    expect(mlsService.addMember).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('refuses on a tree it cannot read, and keeps the row for the next sweep', async () => {
    const log = vi.fn();
    const mlsService = makeMls({
      ...pendingFor('peer', 'new-phone', false),
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
    approveMemberDevice('peer', 'new-phone', 'fp-1');

    await sweep(mlsService);

    expect(mlsService.addMember).toHaveBeenCalledTimes(1);
    expect(mlsService.addMember).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ userId: 'peer', deviceId: 'new-phone' }),
      ['peer:new-phone']
    );
  });
});

// ── the ask announced to every online admitted member ───────────────────────

/**
 * THE SERVER PUTS AN INVITATION-LINK ASK TO EVERY ONLINE ADMITTED MEMBER (`group.join_ask`), not to
 * the one member the `welcome_request` election picks - measured on dev 2026-10-25, the owner with
 * the conversation open learned of it minutes later, at its next sweep. Raised here from this
 * device's own tree, and it adds nobody.
 */
describe('raiseAnnouncedJoinAsk - every online member sees the ask live', () => {
  const announced = (groupId: string, deviceIds = ['dev-1', 'dev-2']) => ({
    groupId,
    askId: `ask-${groupId}`,
    requesterUserId: 'stranger',
    requesterDeviceIds: deviceIds,
  });
  const raise = (
    groupId: string,
    identities: () => Promise<string[]>,
    conversations: Map<string, Conversation> = activeConversations(groupId),
    deviceIds?: string[]
  ) =>
    raiseAnnouncedJoinAsk({
      mlsService: { getGroupMemberIdentities: vi.fn(identities) },
      conversations,
      ask: announced(groupId, deviceIds),
      log: vi.fn(),
      onJoinApprovalRequested: raiseJoinRequest,
    });

  beforeEach(() => {
    resetJoinRequests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('raises one ask holding every device of a person absent from the tree', async () => {
    await raise('g-ann', async () => ['me:self', 'peer:p1']);

    expect(pendingJoinRequests()).toEqual([
      { groupId: 'g-ann', userId: 'stranger', deviceIds: ['dev-1', 'dev-2'], askId: 'ask-g-ann' },
    ]);
  });

  it("raises nothing for a person who already holds a leaf - another member's Add came first", async () => {
    await raise('g-ann-member', async () => ['me:self', 'stranger:dev-1']);

    expect(pendingJoinRequests()).toEqual([]);
  });

  it('raises nothing when the tree cannot be read, or for a 1:1 conversation', async () => {
    await raise('g-ann-unread', async () => {
      throw new Error('Group not found');
    });
    await raise('g-ann-dm', async () => ['me:self'], activeConversations('g-ann-dm', 'direct'));

    expect(pendingJoinRequests()).toEqual([]);
  });

  it("is one entry with the elected member's welcome_request and the sweep raising the same ask", async () => {
    raiseJoinRequest({ groupId: 'g-ann', requesterUserId: 'stranger', requesterDeviceId: 'dev-1' });
    await raise('g-ann', async () => ['me:self']);

    expect(pendingJoinRequests()).toHaveLength(1);
  });

  it('does not put back an ask the server settled while the tree was being read', async () => {
    await raise('g-ann-race', async () => {
      // Another member declined; the settlement arrives before this read answers.
      settleJoinRequest({
        groupId: 'g-ann-race',
        userId: 'stranger',
        askId: 'ask-g-ann-race',
        outcome: 'declined',
      });
      return ['me:self'];
    });

    expect(pendingJoinRequests()).toEqual([]);
  });
});
