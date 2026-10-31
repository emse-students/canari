// @vitest-environment happy-dom
/**
 * A MEMBER'S ANSWER TO A JOIN ASK, AND THE INVITATION LINK END TO END.
 *
 * A link is an ASK, never an admission: the server marks the person's roster row as awaiting a
 * member (`awaitingAdmission`), refuses them the external-join base, and their device asks a member
 * instead (`welcome_request`). The member's device raises "X asks to join", and only that member's own
 * Add brings them in. These cases run both ends against each other - the joiner's `requestReAdd`, the
 * member's `handleWelcomeRequest`, the banner's `answerJoinRequest` - with the network replaced by a
 * direct call, so the chain that a link join depends on is pinned link by link.
 *
 * docs/wiki/protocols/mls-protocol.md, "Who admits a new person".
 */
vi.mock('$lib/utils/hex', () => ({
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import { handleWelcomeRequest } from './actions';
import type { BulkAdditionOutcome } from './groupCreation';
import { admitJoinRequest, declineJoinRequest, type JoinAnswerDeps } from './joinAnswers';
import {
  answerJoinRequest,
  pendingJoinRequests,
  raiseJoinRequest,
  resetJoinRequests,
  setJoinRequestHandlers,
  type JoinRequest,
} from './joinRequests.svelte';
import { requestReAdd, resetReAddCooldowns } from './recovery';
import { resetHistoryReconciliation, setHistoryProbeSender } from './historyReconcile';
import { resetWelcomeSent } from './welcomeSent';

const GROUP = 'g-link';
const JOINER = 'joiner';
const JOINER_DEVICE = 'joiner-dev';

function conversations(conversationType?: Conversation['conversationType']) {
  return new Map<string, Conversation>([
    [
      GROUP,
      {
        id: GROUP,
        contactName: GROUP,
        name: 'Club',
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
        ...(conversationType ? { conversationType } : {}),
      } as Conversation,
    ],
  ]);
}

/**
 * What the delivery service holds for the joiner's seat, shared by both ends as the real server is:
 * the link writes it awaiting, a member's Add stores a Welcome (which lifts the flag), the joiner's
 * device reports itself active once it processed that Welcome, and a Decline withdraws the seat only
 * while it still awaits.
 */
interface FakeSeat {
  exists: boolean;
  awaitingAdmission: boolean;
  status: 'pending' | 'active';
  welcomeQueued: boolean;
}

function linkSeat(): FakeSeat {
  return { exists: true, awaitingAdmission: true, status: 'pending', welcomeQueued: false };
}

/** The member's side: a tree that holds `leaves`, and an Add that puts the joiner in it. */
function memberSide(
  opts: {
    addOutcome?: BulkAdditionOutcome;
    leaves?: string[];
    seat?: FakeSeat;
    collectorFails?: boolean;
  } = {}
) {
  const seat = opts.seat ?? linkSeat();
  const leaves = [...(opts.leaves ?? ['me:self', 'peer:p1'])];
  const mlsService = createMlsServiceStub({
    getGroupMeta: vi.fn().mockResolvedValue({ name: 'Club', isGroup: true }),
    // The roster read names the joiner's seat an ask while it still awaits a member.
    getGroupUserMembers: vi.fn(async () => [
      { userId: 'me' },
      { userId: JOINER, awaitingAdmission: seat.awaitingAdmission },
    ]),
    fetchUserDevices: vi
      .fn()
      .mockResolvedValue([{ deviceId: JOINER_DEVICE, keyPackage: new Uint8Array([7]) }]),
    getGroupMemberIdentities: vi.fn(async () => [...leaves]),
    // The seat as the roster read at a generation answers it.
    getGroupRosterAtGeneration: vi.fn(async () => ({
      members: [
        { userId: 'me' },
        ...(seat.exists ? [{ userId: JOINER, awaitingAdmission: seat.awaitingAdmission }] : []),
      ],
      seatGeneration: 1,
    })),
    // The server's guarded withdrawal: only a seat that still awaits a member.
    declineJoinRequest: vi.fn(async () => {
      if (!seat.exists) return 'gone' as const;
      if (!seat.awaitingAdmission) return 'already-admitted' as const;
      seat.exists = false;
      return 'withdrawn' as const;
    }),
  });
  const outcome: BulkAdditionOutcome = opts.addOutcome ?? {
    kind: 'added',
    addedUsers: [JOINER],
  };
  const invite = vi.fn(async (): Promise<BulkAdditionOutcome> => {
    if (outcome.kind === 'added') {
      leaves.push(`${JOINER}:${JOINER_DEVICE}`);
      // The Add's Welcome is stored by a member: the server lifts the ask with it.
      seat.awaitingAdmission = false;
      seat.welcomeQueued = true;
    }
    return outcome;
  });
  // The stray collector: takes out the joiner's leaves, as it does for a leaf under no admitted seat.
  const collectStrayLeaves = vi.fn(async () => {
    if (opts.collectorFails) return false;
    const before = leaves.length;
    leaves.splice(0, leaves.length, ...leaves.filter((l) => !l.startsWith(`${JOINER}:`)));
    return leaves.length < before;
  });
  const deps: JoinAnswerDeps = {
    mlsService: mlsService as unknown as JoinAnswerDeps['mlsService'],
    conversations: conversations(),
    invite,
    collectStrayLeaves,
    log: vi.fn(),
  };
  return { mlsService, invite, deps, leaves, seat, collectStrayLeaves };
}

/**
 * The joiner's side: the server answers its seat as `awaitingAdmission`, and its `welcome_request`
 * reaches the member's `handleWelcomeRequest` directly.
 */
function joinerSide(member: ReturnType<typeof memberSide>) {
  const mlsService = {
    getGroupMeta: vi.fn().mockResolvedValue({ groupId: GROUP, isGroup: true, deletedAt: null }),
    getGroupServerStatus: vi
      .fn()
      .mockResolvedValue({ groupId: GROUP, isGroup: true, deletedAt: null }),
    notifyConversationAvailable: vi.fn(),
    getLocalGroups: vi.fn().mockReturnValue([]),
    sendWelcomeRequest: vi.fn(async (groupId: string) => {
      await handleWelcomeRequest({
        mlsService: member.mlsService as unknown as IMlsService,
        storage: null,
        userId: 'me',
        deviceKeyB64: 'pin',
        conversations: member.deps.conversations as Map<string, Conversation>,
        log: vi.fn(),
        requesterUserId: JOINER,
        requesterDeviceId: JOINER_DEVICE,
        groupId,
        onJoinApprovalRequested: raiseJoinRequest,
      });
    }),
    sendBaseRefreshRequest: vi.fn().mockResolvedValue({ noPeerOnline: false }),
    sendHistoryRequest: vi.fn().mockResolvedValue({ noPeerOnline: false }),
    isDistributionGroup: vi.fn().mockReturnValue(false),
    noteDistributionGroup: vi.fn(),
    waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
    // A seat whose Welcome is queued pulls this device's own mailbox rather than asking a member.
    fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
    externalJoin: vi.fn().mockResolvedValue({ joined: true }),
    forgetGroup: vi.fn(),
    getDeviceId: vi.fn().mockReturnValue(JOINER_DEVICE),
    // Read off the shared seat, as `GET mls/device-memberships` answers it.
    getDeviceMemberships: vi.fn(async () =>
      member.seat.exists
        ? [
            {
              id: 'm-1',
              userId: JOINER,
              deviceId: JOINER_DEVICE,
              groupId: GROUP,
              status: member.seat.status,
              welcomeQueued: member.seat.welcomeQueued,
              addInFlight: false,
              awaitingAdmission: member.seat.awaitingAdmission,
            },
          ]
        : []
    ),
    // The account's list names the group while the seat exists, as `GET mls/users/:id/groups` does.
    getUserGroups: vi.fn(async () =>
      member.seat.exists ? [{ groupId: GROUP, name: 'Club', isGroup: true }] : []
    ),
    updateInvitationStatus: vi.fn().mockResolvedValue(undefined),
  };
  const deps = {
    mlsService,
    storage: null,
    userId: JOINER,
    deviceKey: () => 'device-key',
    conversations: new Map(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  } as any;
  return { mlsService, deps };
}

/** The joiner follows its link; the ask reaches the member's banner. */
async function joinByLink(member: ReturnType<typeof memberSide>) {
  const joiner = joinerSide(member);
  await requestReAdd(GROUP, joiner.deps);
  return joiner;
}

beforeEach(() => {
  resetJoinRequests();
  resetReAddCooldowns();
  resetHistoryReconciliation();
  setHistoryProbeSender(vi.fn().mockResolvedValue(true));
  resetWelcomeSent();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  setJoinRequestHandlers(null);
  vi.restoreAllMocks();
});

const request: JoinRequest = { groupId: GROUP, userId: JOINER, deviceIds: [JOINER_DEVICE] };

describe('admitJoinRequest - done only when the person is in the tree', () => {
  it('is done when the Add put a device of theirs in the tree', async () => {
    const m = memberSide();

    expect(await admitJoinRequest(request, m.deps)).toEqual({ done: true });
    expect(m.invite).toHaveBeenCalledWith([JOINER], m.deps.conversations.get(GROUP), undefined);
  });

  it('answers AS the ask it was tapped on: the Add carries its identity', async () => {
    // So the Add stops before its stage if a Decline settled that ask first (`rosterPremise`).
    const m = memberSide();

    expect(await admitJoinRequest({ ...request, askId: 'ask-1' }, m.deps)).toEqual({ done: true });
    expect(m.invite).toHaveBeenCalledWith([JOINER], m.deps.conversations.get(GROUP), {
      userId: JOINER,
      askId: 'ask-1',
    });
  });

  it('is not done when the Add did not happen, and names why', async () => {
    const m = memberSide({ addOutcome: { kind: 'not-added', reason: 'add-lock-busy' } });

    expect(await admitJoinRequest(request, m.deps)).toEqual({
      done: false,
      reason: 'the Add did not happen (add-lock-busy)',
    });
  });

  it('is not done when the Add admitted somebody else', async () => {
    const m = memberSide({ addOutcome: { kind: 'added', addedUsers: ['other'] } });

    expect((await admitJoinRequest(request, m.deps)).done).toBe(false);
  });

  it('adds nobody when another member already did', async () => {
    const m = memberSide({
      leaves: ['me:self', `${JOINER}:${JOINER_DEVICE}`],
      seat: { ...linkSeat(), awaitingAdmission: false },
    });

    expect(await admitJoinRequest(request, m.deps)).toEqual({ done: true });
    expect(m.invite).not.toHaveBeenCalled();
    expect(m.collectStrayLeaves).not.toHaveBeenCalled();
  });

  it('a leaf is not an admission: under a seat still awaiting, it is removed and the member Adds', async () => {
    const m = memberSide({ leaves: ['me:self', `${JOINER}:${JOINER_DEVICE}`] });

    expect(await admitJoinRequest(request, m.deps)).toEqual({ done: true });
    expect(m.collectStrayLeaves).toHaveBeenCalledExactlyOnceWith(GROUP);
    expect(m.invite).toHaveBeenCalledOnce();
    // The member's own Add lifted the seat, not the leaf it found.
    expect(m.seat.awaitingAdmission).toBe(false);
  });

  it('is not done while a leaf under a seat still awaiting could not be removed', async () => {
    const m = memberSide({
      leaves: ['me:self', `${JOINER}:${JOINER_DEVICE}`],
      collectorFails: true,
    });

    expect((await admitJoinRequest(request, m.deps)).done).toBe(false);
    expect(m.invite).not.toHaveBeenCalled();
    expect(m.seat.awaitingAdmission).toBe(true);
  });

  it('answers nothing about a 1:1 conversation', async () => {
    const m = memberSide();
    m.deps.conversations = conversations('direct');

    expect((await admitJoinRequest(request, m.deps)).done).toBe(false);
    expect(m.invite).not.toHaveBeenCalled();
  });
});

describe('declineJoinRequest - the guarded withdrawal, never a removal', () => {
  it('withdraws the seat of a person still awaiting a member', async () => {
    const m = memberSide();

    expect(await declineJoinRequest(request, m.deps)).toEqual({ done: true });
    expect(m.mlsService.declineJoinRequest).toHaveBeenCalledWith(GROUP, JOINER);
    expect(m.seat.exists).toBe(false);
    // Never the generic removal: it does not re-check the ask, and records an eviction.
    expect(m.mlsService.removeMemberFromServer).not.toHaveBeenCalled();
  });

  it('leaves whole a person another member admitted first, even before this tree shows it', async () => {
    // Member A's Add lifted the ask; this device has not processed that epoch yet, so its own tree
    // still says "no leaf". The server, not the tree, answers.
    const seat: FakeSeat = { ...linkSeat(), awaitingAdmission: false, welcomeQueued: true };
    const m = memberSide({ seat });

    expect(await declineJoinRequest(request, m.deps)).toEqual({ done: true });
    expect(seat.exists).toBe(true);
    expect(m.deps.log).toHaveBeenCalledWith(expect.stringContaining('admitted them first'));
  });

  it("says the truth of a seat that was never an ask - not another member's Add", async () => {
    // A seat older than the rule, or a member's invite between its roster write and its Add: the
    // server answers `not-awaiting`, and the log must not claim an admission nothing records.
    const m = memberSide();
    m.mlsService.declineJoinRequest = vi.fn().mockResolvedValue('not-awaiting');

    expect(await declineJoinRequest(request, m.deps)).toEqual({ done: true });
    expect(m.deps.log).toHaveBeenCalledWith(
      expect.stringContaining('not an invitation-link ask, so there is nothing to withdraw')
    );
    expect(m.deps.log).not.toHaveBeenCalledWith(expect.stringContaining('admitted them first'));
  });

  it('is not done when the server refused the decline', async () => {
    const m = memberSide();
    m.mlsService.declineJoinRequest = vi.fn().mockRejectedValue(new Error('403'));

    expect((await declineJoinRequest(request, m.deps)).done).toBe(false);
  });
});

describe('a join by invitation link, end to end', () => {
  function register(m: ReturnType<typeof memberSide>) {
    setJoinRequestHandlers({
      approve: (r) => admitJoinRequest(r, m.deps),
      decline: (r) => declineJoinRequest(r, m.deps),
    });
  }

  it('the joiner asks instead of joining, and the ask reaches the member', async () => {
    const m = memberSide();

    const joiner = await joinByLink(m);

    expect(joiner.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(joiner.mlsService.sendWelcomeRequest).toHaveBeenCalledWith(GROUP);
    // No automatic Add: the member's device only raised the ask.
    expect(m.mlsService.addMember).not.toHaveBeenCalled();
    expect(pendingJoinRequests()).toEqual([
      { groupId: GROUP, userId: JOINER, deviceIds: [JOINER_DEVICE] },
    ]);
  });

  it('approve: the member Adds them and the ask leaves', async () => {
    const m = memberSide();
    register(m);
    await joinByLink(m);

    const [ask] = pendingJoinRequests();
    expect(await answerJoinRequest(ask, 'approve')).toBe(true);

    expect(m.invite).toHaveBeenCalledTimes(1);
    expect(m.leaves).toContain(`${JOINER}:${JOINER_DEVICE}`);
    expect(pendingJoinRequests()).toEqual([]);
  });

  it('accept -> ask -> Add -> Welcome: the joiner never serves itself an external join', async () => {
    const m = memberSide();
    register(m);
    const joiner = await joinByLink(m);
    const [ask] = pendingJoinRequests();
    expect(await answerJoinRequest(ask, 'approve')).toBe(true);

    // The Add stored a Welcome: the seat is owed, no longer awaiting - the joiner waits for it.
    resetReAddCooldowns();
    joiner.mlsService.sendWelcomeRequest.mockClear();
    await requestReAdd(GROUP, joiner.deps);
    expect(joiner.mlsService.externalJoin).not.toHaveBeenCalled();
    // Waits by pulling its own mailbox, where the Welcome is - and asks no member again.
    expect(joiner.mlsService.fetchPendingMessages).toHaveBeenCalled();
    expect(joiner.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();

    // The Welcome processed, the device reports itself active: in the tree, nothing left to join.
    m.seat.status = 'active';
    m.seat.welcomeQueued = false;
    expect(m.seat.awaitingAdmission).toBe(false);
    expect(pendingJoinRequests()).toEqual([]);
  });

  it('decline: the seat is withdrawn, no Add is made, the ask leaves, and the joiner stays out', async () => {
    const m = memberSide();
    register(m);
    const joiner = await joinByLink(m);

    const [ask] = pendingJoinRequests();
    expect(await answerJoinRequest(ask, 'decline')).toBe(true);

    expect(m.mlsService.declineJoinRequest).toHaveBeenCalledWith(GROUP, JOINER);
    expect(m.invite).not.toHaveBeenCalled();
    expect(pendingJoinRequests()).toEqual([]);
    // No seat any more, and the joiner READS it rather than learning it from a refusal (ADM-2,
    // 2026-10-25): its never-admitted row goes, no external join is tried, nobody is asked again,
    // and no `removed` conversation is left listed.
    resetReAddCooldowns();
    joiner.mlsService.sendWelcomeRequest.mockClear();
    joiner.mlsService.externalJoin = vi.fn().mockRejectedValue(new NotAGroupMemberError(GROUP));
    joiner.deps.conversations.set(GROUP, {
      id: GROUP,
      name: 'Club',
      lifecycle: 'pending',
      awaitingAdmission: true,
    });
    await requestReAdd(GROUP, joiner.deps);
    expect(joiner.mlsService.sendWelcomeRequest).not.toHaveBeenCalled();
    expect(joiner.mlsService.externalJoin).not.toHaveBeenCalled();
    expect(joiner.deps.conversations.has(GROUP)).toBe(false);
    expect(pendingJoinRequests()).toEqual([]);
  });

  it('an approve whose Add did not happen keeps the ask on screen', async () => {
    for (const reason of ['add-lock-busy', 'failed', 'no-device-added'] as const) {
      resetJoinRequests();
      resetReAddCooldowns();
      const m = memberSide({ addOutcome: { kind: 'not-added', reason } });
      register(m);
      await joinByLink(m);

      const [ask] = pendingJoinRequests();
      expect(await answerJoinRequest(ask, 'approve')).toBe(false);

      expect(pendingJoinRequests()).toHaveLength(1);
      expect(m.leaves).not.toContain(`${JOINER}:${JOINER_DEVICE}`);
    }
  });
});
