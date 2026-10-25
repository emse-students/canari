// @vitest-environment happy-dom
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalMessaging: { isMessageCatchupActive: false, resetMessageCatchupState: vi.fn() },
}));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));
vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/hex')>()),
  saveMlsState: vi.fn().mockResolvedValue(undefined),
}));

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
    processIncomingMessage: vi.fn(async () => null),
    getGroupUserMembers: vi.fn(async () => [...roster].map((userId) => ({ userId }))),
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
        _invitation?: unknown
      ) => {
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
  afterEach(() => vi.restoreAllMocks());

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

  it('a commit the gate refused for its bytes is not re-planned - the member is told', async () => {
    const h = harness();
    const outcome = await replanLostInvitation(
      owed({ cause: 'refused' }),
      { id: G } as never,
      h.deps as never
    );

    expect(outcome).toEqual({ kind: 'not-completed', reason: 'failed' });
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

  it('writes the invitation and its roster baseline into the commit', async () => {
    const h = harness();
    h.roster.add('w5');
    await inviteMembersToGroup(['W5', 'w6'], { id: G } as never, h.deps as never);

    expect(h.mlsService.addMembersBulk.mock.calls[0][3]).toEqual({
      users: ['w5', 'w6'],
      rostered: ['w5'],
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
