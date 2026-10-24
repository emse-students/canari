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

/** The member's side: a tree that holds `leaves`, and an Add that puts the joiner in it. */
function memberSide(opts: { addOutcome?: BulkAdditionOutcome; leaves?: string[] } = {}) {
  const leaves = [...(opts.leaves ?? ['me:self', 'peer:p1'])];
  const mlsService = createMlsServiceStub({
    getGroupMeta: vi.fn().mockResolvedValue({ name: 'Club', isGroup: true }),
    getGroupUserMembers: vi.fn().mockResolvedValue([{ userId: 'me' }, { userId: JOINER }]),
    fetchUserDevices: vi
      .fn()
      .mockResolvedValue([{ deviceId: JOINER_DEVICE, keyPackage: new Uint8Array([7]) }]),
    getGroupMemberIdentities: vi.fn(async () => [...leaves]),
    removeMemberFromServer: vi.fn().mockResolvedValue(undefined),
  });
  const outcome: BulkAdditionOutcome = opts.addOutcome ?? {
    kind: 'added',
    addedUsers: [JOINER],
  };
  const invite = vi.fn(async (): Promise<BulkAdditionOutcome> => {
    if (outcome.kind === 'added') leaves.push(`${JOINER}:${JOINER_DEVICE}`);
    return outcome;
  });
  const deps: JoinAnswerDeps = {
    mlsService: mlsService as unknown as JoinAnswerDeps['mlsService'],
    conversations: conversations(),
    invite,
    log: vi.fn(),
  };
  return { mlsService, invite, deps, leaves };
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
    externalJoin: vi.fn().mockResolvedValue({ joined: true }),
    forgetGroup: vi.fn(),
    getDeviceId: vi.fn().mockReturnValue(JOINER_DEVICE),
    getDeviceMemberships: vi.fn().mockResolvedValue([
      {
        id: 'm-1',
        userId: JOINER,
        deviceId: JOINER_DEVICE,
        groupId: GROUP,
        status: 'pending',
        welcomeQueued: false,
        addInFlight: false,
        awaitingAdmission: true,
      },
    ]),
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
    expect(m.invite).toHaveBeenCalledWith([JOINER], m.deps.conversations.get(GROUP));
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
    const m = memberSide({ leaves: ['me:self', `${JOINER}:${JOINER_DEVICE}`] });

    expect(await admitJoinRequest(request, m.deps)).toEqual({ done: true });
    expect(m.invite).not.toHaveBeenCalled();
  });

  it('answers nothing about a 1:1 conversation', async () => {
    const m = memberSide();
    m.deps.conversations = conversations('direct');

    expect((await admitJoinRequest(request, m.deps)).done).toBe(false);
    expect(m.invite).not.toHaveBeenCalled();
  });
});

describe('declineJoinRequest - removes a roster row, never a leaf', () => {
  it('removes the roster row of a person who holds no leaf', async () => {
    const m = memberSide();

    expect(await declineJoinRequest(request, m.deps)).toEqual({ done: true });
    expect(m.mlsService.removeMemberFromServer).toHaveBeenCalledWith(GROUP, JOINER);
  });

  it('leaves alone a person another member admitted meanwhile', async () => {
    const m = memberSide({ leaves: ['me:self', `${JOINER}:${JOINER_DEVICE}`] });

    expect((await declineJoinRequest(request, m.deps)).done).toBe(false);
    expect(m.mlsService.removeMemberFromServer).not.toHaveBeenCalled();
  });

  it('is not done when the server refused the removal', async () => {
    const m = memberSide();
    m.mlsService.removeMemberFromServer = vi.fn().mockRejectedValue(new Error('403'));

    expect((await declineJoinRequest(request, m.deps)).done).toBe(false);
  });

  it('answers nothing when the tree cannot be read', async () => {
    const m = memberSide();
    m.mlsService.getGroupMemberIdentities = vi.fn().mockRejectedValue(new Error('no group'));

    expect(await declineJoinRequest(request, m.deps)).toEqual({
      done: false,
      reason: 'the tree could not be read',
    });
    expect(m.mlsService.removeMemberFromServer).not.toHaveBeenCalled();
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

  it('decline: their roster row leaves the server, no Add is made, and the ask leaves', async () => {
    const m = memberSide();
    register(m);
    await joinByLink(m);

    const [ask] = pendingJoinRequests();
    expect(await answerJoinRequest(ask, 'decline')).toBe(true);

    expect(m.mlsService.removeMemberFromServer).toHaveBeenCalledWith(GROUP, JOINER);
    expect(m.invite).not.toHaveBeenCalled();
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
