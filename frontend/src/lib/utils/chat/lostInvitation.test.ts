// @vitest-environment happy-dom
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
}));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
// The inviter's own `memberAdded` notice resolves names: a profile read nothing here is about.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveDisplayNames: async () => (id: string) => id,
}));
vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/hex')>()),
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

/** The catch-up a confirmation runs, replaced only by the case that needs one (see there). */
const catchUp = vi.hoisted(() => ({ run: null as null | (() => Promise<unknown>) }));
vi.mock('./commitReplay', async (importOriginal) => {
  const real = await importOriginal<typeof import('./commitReplay')>();
  return {
    ...real,
    replayAndRecord: (...args: Parameters<typeof real.replayAndRecord>) =>
      catchUp.run ? catchUp.run() : real.replayAndRecord(...args),
  };
});

import { inviteMembersToGroup, replanLostInvitation } from './groupCreation';
import {
  CommitOutcomeUnknownError,
  PreviousCommitUnresolvedError,
} from '$lib/mls-client/commitSubmission';
import type { OwedInvitation } from '$lib/mls-client/owedInvitations';

/**
 * A MEMBER'S INVITATION WHOSE KEPT COMMIT DID NOT LAND IS MADE AGAIN AT THE EPOCH THAT WON (OFF-3,
 * 1.4.1 campaign) - under the premises of a rebuilt Add, judged against the gesture's OWN start. W1
 * invited W5 at epoch 2 and lost the answer; W2 took the group to 5 meanwhile. The re-plan seats W5
 * once, and never brings back a person removed, declined or departed meanwhile.
 */
const G = 'g1';

function harness() {
  const state = { epoch: 5, tree: ['w1:dev-1', 'w2:dev-2', 'w4:w4-dev'] };
  const roster = new Set(['w1', 'w2', 'w4']);
  const departures = new Map<string, number[]>();
  const mlsService = {
    runUnderMlsLock: vi.fn((fn: () => Promise<unknown>) => fn()),
    fetchCommitsSince: vi.fn(async () => ({
      commits: [],
      activeEpoch: state.epoch,
      belowFloor: false,
    })),
    settleUnresolvedCommitFromLog: vi.fn(async () => 'none'),
    notifyCommitsApplied: vi.fn(),
    processIncomingMessage: vi.fn(async () => null),
    getGroupUserMembers: vi.fn(async () => [...roster].map((userId) => ({ userId }))),
    getGroupRosterAtGeneration: vi.fn(async () => ({
      members: [...roster].map((userId) => ({ userId })),
      seatGeneration: 0,
    })),
    removalEpochs: vi.fn(async (_g: string, u: string) => departures.get(u) ?? []),
    getEpoch: vi.fn(() => state.epoch),
    getGroupMemberIdentities: vi.fn(async () => [...state.tree]),
    registerMember: vi.fn(async (_g: string, u: string) => void roster.add(u)),
    fetchUserDevices: vi.fn(async (u: string) => [
      { deviceId: `${u}-dev`, keyPackage: new Uint8Array([4]) },
    ]),
    acquireAddLock: vi.fn(async () => true),
    releaseAddLock: vi.fn(async () => {}),
    addMembersBulk: vi.fn(
      async (
        _g: string,
        devices: Array<{ userId: string; deviceId: string }>,
        _excludes?: string[],
        _invitation?: unknown,
        beforeStage?: () => Promise<void>
      ) => {
        // Under the MLS lock, right before the stage - as `addMembersBulk` runs it.
        await beforeStage?.();
        state.tree.push(...devices.map((d) => `${d.userId}:${d.deviceId}`));
        state.epoch += 1;
        return {
          addedDeviceIds: devices.map((d) => d.deviceId),
          skipped: [],
          welcome: new Uint8Array([1]),
        };
      }
    ),
    sendWelcome: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    getDeviceId: vi.fn(() => 'dev-1'),
  };
  const deps = {
    mlsService: mlsService as never,
    storage: null,
    userId: 'w1',
    deviceKeyB64: 'k',
    historyBaseUrl: 'https://example.invalid',
    conversations: new SvelteMap(),
    selectConversation: vi.fn(),
    saveConversation: vi.fn(async () => {}),
    log: vi.fn(),
    addMessageToChat: vi.fn(),
  };
  return { state, roster, departures, mlsService, deps };
}

const owed = (over: Partial<OwedInvitation> = {}): OwedInvitation => ({
  groupId: G,
  baseEpoch: 2,
  invitation: { users: ['w5'], rostered: [] },
  cause: 'race',
  ...over,
});

describe('replanLostInvitation - the invitation a kept commit lost', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    catchUp.run = null;
    vi.restoreAllMocks();
  });

  it('OFF-3: re-issues the Add ONCE at epoch 5, and W5 ends with a seat', async () => {
    const h = harness();
    const outcome = await replanLostInvitation(owed(), { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(h.mlsService.addMembersBulk).toHaveBeenCalledTimes(1);
    // The new commit carries the invitation on, with the GESTURE's baseline - not a read made now.
    expect(h.mlsService.addMembersBulk.mock.calls[0][3]).toEqual({ users: ['w5'], rostered: [] });
    expect(h.state.tree).toContain('w5:w5-dev');
    expect(h.state.epoch).toBe(6);
    expect(h.roster.has('w5')).toBe(true);
    expect(h.mlsService.sendWelcome).toHaveBeenCalledTimes(1);
  });

  it('a second re-plan of the same entry (a reload after the Add merged) adds NOTHING', async () => {
    const h = harness();
    await replanLostInvitation(owed(), { id: G } as never, h.deps as never);
    const again = await replanLostInvitation(owed(), { id: G } as never, h.deps as never);

    expect(again).toEqual({ kind: 'completed' });
    expect(h.mlsService.addMembersBulk).toHaveBeenCalledTimes(1);
  });

  it('a person REMOVED after the lost commit (a departure past its base) is never brought back', async () => {
    const h = harness();
    // W2 added W5 at 3 and removed them at 4: the roster reads the same as at the gesture.
    h.departures.set('w5', [4]);
    const outcome = await replanLostInvitation(owed(), { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-completed', reason: 'removed-meanwhile' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('ADDED AND REMOVED BY OTHERS IN COMMITS THIS DEVICE HAS NOT APPLIED YET: read after the catch-up, never re-added', async () => {
    const h = harness();
    // Back from the absence at epoch 2; the server is at 5. W2 added W5 at 3 and removed them at 4 -
    // commits only the catch-up applies, so before it the tree's record shows no departure, and the
    // tree (W5 holds no leaf) would need no confirmation at all.
    let local = 2;
    h.mlsService.getEpoch.mockImplementation(() => local);
    h.mlsService.fetchCommitsSince.mockImplementation(async () => ({
      commits: [],
      activeEpoch: 5,
      belowFloor: false,
    }));
    catchUp.run = async () => {
      local = 5;
      h.departures.set('w5', [4]);
      return { healed: true, belowFloor: false, applied: 3, heldBehindRefusedBacklog: false };
    };
    const outcome = await replanLostInvitation(owed(), { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-completed', reason: 'removed-meanwhile' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('a Remove APPLIED BETWEEN the confirmation and the stage is seen under the lock: nothing staged', async () => {
    const h = harness();
    // The confirmed premise reads no departure; a Remove of W5 is applied before the stage.
    let reads = 0;
    h.mlsService.removalEpochs.mockImplementation(async (_g: string, u: string) =>
      u === 'w5' && ++reads > 1 ? [6] : []
    );
    const outcome = await replanLostInvitation(owed(), { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-completed', reason: 'removed-meanwhile' });
    expect(h.state.tree).not.toContain('w5:w5-dev');
  });

  // EVERY WAY A TREE STAYS UNCONFIRMED IS TRANSIENT AND STAGES NOTHING, so a resumed invitation
  // WAITS on each (its entry kept, re-planned at the group's next commit or connection), never drops.
  it.each([
    ['the log could not be read', 'fetch'],
    ['the replay is held behind frames refused for lack of a row', 'held'],
    ['the catch-up stopped short of the server', 'short'],
  ] as const)('an unconfirmed tree - %s - is WAITING', async (_what, how) => {
    const h = harness();
    h.mlsService.getEpoch.mockImplementation(() => 2);
    h.mlsService.fetchCommitsSince.mockImplementation(async () => {
      if (how === 'fetch') throw new Error('offline');
      return { commits: [], activeEpoch: 5, belowFloor: false };
    });
    catchUp.run = async () => ({
      healed: false,
      belowFloor: false,
      applied: 0,
      heldBehindRefusedBacklog: how === 'held',
    });
    const outcome = await replanLostInvitation(owed(), { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'waiting', on: 'tree-unconfirmed' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('another device holds the add lock: WAITING - nothing staged, the invitation is not over', async () => {
    const h = harness();
    h.mlsService.acquireAddLock.mockResolvedValueOnce(false);
    const outcome = await replanLostInvitation(owed(), { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'waiting', on: 'add-lock' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('a join ask DECLINED meanwhile (on the roster at the gesture, off it now) is never re-added', async () => {
    const h = harness();
    const outcome = await replanLostInvitation(
      owed({ invitation: { users: ['w5'], rostered: ['w5'] } }),
      { id: G } as never,
      h.deps as never
    );

    expect(outcome).toEqual({ kind: 'not-completed', reason: 'removed-meanwhile' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('a person who became a member meanwhile (another Add) is not added twice', async () => {
    const h = harness();
    h.state.tree.push('w5:w5-dev');
    const outcome = await replanLostInvitation(owed(), { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('no baseline recorded with the lost commit: nothing is guessed, the member is told', async () => {
    const h = harness();
    const outcome = await replanLostInvitation(
      owed({ invitation: { users: ['w5'] } }),
      { id: G } as never,
      h.deps as never
    );

    expect(outcome).toEqual({ kind: 'not-completed', reason: 'commit-race-lost' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('a commit the gate refused (its typed reason) is not re-planned - the member is told why', async () => {
    const h = harness();
    const outcome = await replanLostInvitation(
      owed({ cause: 'refused', reason: 'committer_not_member' }),
      { id: G } as never,
      h.deps as never
    );

    expect(outcome).toEqual({ kind: 'refused', reason: 'committer_not_member' });
    expect(h.mlsService.addMembersBulk).not.toHaveBeenCalled();
  });

  it('a re-plan whose own Add gets no answer is KEPT - its intent carries the invitation on', async () => {
    const h = harness();
    h.mlsService.addMembersBulk.mockRejectedValueOnce(new CommitOutcomeUnknownError(G, 5, 'lost'));
    const outcome = await replanLostInvitation(owed(), { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'kept' });
  });
});

describe('inviteMembersToGroup - an Add that got no answer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes the invitation, its roster baseline and the seat generation it was decided at into the commit', async () => {
    const h = harness();
    h.roster.add('w5');
    h.mlsService.getGroupRosterAtGeneration.mockImplementation(async () => ({
      members: [...h.roster].map((userId) => ({ userId })),
      seatGeneration: 4,
    }));
    await inviteMembersToGroup(['W5', 'w6'], { id: G } as never, h.deps as never);

    // The generation is what the gate orders a Decline against (ADM-3): one recorded after it holds
    // against this Add, one recorded before it does not.
    expect(h.mlsService.addMembersBulk.mock.calls[0][3]).toEqual({
      users: ['w5', 'w6'],
      rostered: ['w5'],
      seatGeneration: 4,
    });
  });

  it('is KEPT, not failed: the member is told it will finish (`outcome-unknown`)', async () => {
    const h = harness();
    h.mlsService.addMembersBulk.mockRejectedValueOnce(new CommitOutcomeUnknownError(G, 5, 'lost'));
    const outcome = await inviteMembersToGroup(['w5'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'outcome-unknown' });
  });

  it('staged NOTHING behind an earlier unanswered commit: theirs to retry', async () => {
    const h = harness();
    h.mlsService.addMembersBulk.mockRejectedValueOnce(new PreviousCommitUnresolvedError(G, 5));
    const outcome = await inviteMembersToGroup(['w5'], { id: G } as never, h.deps as never);

    expect(outcome).toEqual({ kind: 'not-added', reason: 'previous-commit-unresolved' });
  });
});
