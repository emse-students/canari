// Break the app-wide import cycle that otherwise loads the concrete services before BaseMlsService.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));
vi.mock('$lib/mls-client/tabLeader', () => ({ getTabLeadership: () => 'leader' }));

import { BaseMlsService } from '$lib/services/BaseMlsService';
import { removeMemberAndBroadcast } from './groupActions';
import { MemberRemovalNotCommittedError } from './memberRemovalError';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { recordingStage } from '../../../test/recordingStage';
import type { IMlsService } from '$lib/mls-client/IMlsService';

/**
 * THE SAME RACES AS `groupActions.removeRace.test.ts`, THROUGH THE REAL COMMIT PATH: the real
 * `BaseMlsService.removeMember` -> `runCommitTransaction` (stage, record, submit, merge or clear),
 * with only the platform primitives and the delivery service stood in. The point a scripted mock
 * cannot make: the MLS lock is taken BEFORE the stage, and incoming commits are applied under the
 * same lock - so a loser of CC-3 does not see a refusal at all, it sees its STAGE fail on a tree the
 * winner's Remove already changed (openmls: `NoSuchMember`, untyped across the platform boundary).
 */
const G = 'group-1';
const BOB = 'user-b';
const ME = 'user-a';
const proto = BaseMlsService.prototype as unknown as Record<string, unknown>;

function realCommitService() {
  const state = { epoch: 7, tree: [`${ME}:da`, `${BOB}:d1`] };
  /** What another member's commit does to this tree when it is applied under the lock. */
  const winner = { pending: null as null | ((tree: string[]) => string[]) };
  const recorder = recordingStage(() => state.epoch);
  const stub = createMlsServiceStub();
  vi.mocked(stub.getEpoch).mockImplementation(() => state.epoch);
  vi.mocked(stub.getGroupMemberIdentities).mockImplementation(async () => [...state.tree]);
  vi.mocked(stub.fetchCommitsSince).mockImplementation(async () => ({
    commits: [],
    activeEpoch: state.epoch,
    belowFloor: false,
  }));
  const stage = recorder.wrap(async () => {
    if (!state.tree.some((leaf) => leaf.startsWith(`${BOB}:`))) {
      throw new Error(`NoSuchMember("no leaf carries any of the identities [\\"${BOB}\\"]")`);
    }
    return { commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) };
  });
  const submitCommit = vi.fn(async () => ({ accepted: true }));
  const svc = Object.assign(stub, {
    userId: ME,
    deviceId: 'da',
    pendingSubmission: recorder.pendingSubmission,
    delivery: { submitCommit, fetchCommitsSince: stub.fetchCommitsSince },
    // THE LOCK: a commit of another member that reached this device is applied under it FIRST.
    runUnderMlsLock: async <T>(fn: () => Promise<T>) => {
      if (winner.pending) {
        state.tree = winner.pending(state.tree);
        state.epoch += 1;
        winner.pending = null;
      }
      return fn();
    },
    freshEpoch: async () => state.epoch,
    groupsWithPendingCommit: async () => [],
    clearPendingCommit: vi.fn(async () => {}),
    mergePendingCommit: vi.fn(async () => {
      state.tree = state.tree.filter((leaf) => !leaf.startsWith(`${BOB}:`));
      state.epoch += 1;
    }),
    // The platform's stage, as `members.rs` writes it: no leaf, no commit - an untyped error.
    stageRemoveMembers: (_g: string, _u: string[], intent: Uint8Array) => stage(intent),
    ...Object.fromEntries(
      [
        'removeMember',
        'runCommitTransaction',
        'settleUnresolvedLocked',
        'checkpointStageBeforeSend',
        'submitRecorded',
        'resubmitUnresolved',
        'catchUpOnRefusedCommit',
      ].map((name) => [name, proto[name]])
    ),
  });
  return { svc: svc as unknown as IMlsService, state, winner, submitCommit };
}

const run = (svc: IMlsService) =>
  removeMemberAndBroadcast({
    mlsService: svc,
    groupId: G,
    memberId: BOB,
    userId: ME,
    deviceKeyB64: 'k',
  });

describe('removeMemberAndBroadcast through the real commit path', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('commits the Remove when nothing races it', async () => {
    const { svc, state, submitCommit } = realCommitService();

    await expect(run(svc)).resolves.toBe('committed');

    expect(submitCommit).toHaveBeenCalledTimes(1);
    expect(state.tree).toEqual([`${ME}:da`]);
  });

  it('CC-3: the winner Remove is applied under the lock first - the stage fails, the loser ends quietly', async () => {
    const { svc, state, winner, submitCommit } = realCommitService();
    winner.pending = (tree) => tree.filter((leaf) => !leaf.startsWith(`${BOB}:`));

    await expect(run(svc)).resolves.toBe('already-out');

    // Nothing was ever submitted: the stage itself found no leaf.
    expect(submitCommit).not.toHaveBeenCalled();
    expect(state.tree).toEqual([`${ME}:da`]);
    expect(console.warn).not.toHaveBeenCalled();
    expect(svc.sendMessage).not.toHaveBeenCalled();
  });

  it('a gate refusal that moved nothing while the member stays is surfaced, never quiet', async () => {
    const { svc, state, submitCommit } = realCommitService();
    submitCommit.mockResolvedValue({
      accepted: false,
      reason: 'concurrent_commit',
      currentEpoch: 7,
    } as never);

    await expect(run(svc)).rejects.toBeInstanceOf(MemberRemovalNotCommittedError);
    expect(state.tree).toContain(`${BOB}:d1`);
  });
});
