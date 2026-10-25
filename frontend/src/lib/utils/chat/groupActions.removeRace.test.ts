// @vitest-environment happy-dom
const leadership = vi.hoisted(() => ({ value: 'leader' as 'leader' | 'follower' | 'undecided' }));
vi.mock('$lib/mls-client/tabLeader', () => ({ getTabLeadership: () => leadership.value }));

import { removeMemberAndBroadcast } from './groupActions';
import { MemberRemovalNotCommittedError } from './memberRemovalError';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import {
  CommitRefusedError,
  SEAT_CLAIM_OVERTAKEN_REASON,
  rebuildableRefusal,
} from '$lib/mls-client/CommitRefusedError';
import {
  CommitOutcomeUnknownError,
  FollowerTabCommitError,
} from '$lib/mls-client/commitSubmission';

/**
 * A REMOVE THAT LOSES THE COMMIT RACE ENDS REBUILT OR SURFACED, NEVER LOGGED ALONE (CC-2, 1.4.1 dev
 * campaign, 2026-10-25). The member is already off the roster when the commit is built, so a refusal
 * swallowed into a log line left them off the roster and in the tree with nobody told. Each test
 * below models the server's gate on a small in-memory tree: the roster and the tree must agree at the
 * end, or the caller must hold the typed error that says they do not.
 */
const G = 'group-1';
const BOB = 'user-b';
const ME = 'user-a';

/** A group whose tree and epoch move the way the gate and the refusal's catch-up move them. */
function harness() {
  const mlsService = createMlsServiceStub();
  const state = { epoch: 3, tree: [`${ME}:da`, `${BOB}:d1`, `${BOB}:d2`] };
  vi.mocked(mlsService.getEpoch).mockImplementation(() => state.epoch);
  vi.mocked(mlsService.getGroupMemberIdentities).mockImplementation(async () => [...state.tree]);
  const accept = async (_g: string, userIds: string[]) => {
    state.tree = state.tree.filter((leaf) => !userIds.some((u) => leaf.startsWith(`${u}:`)));
    state.epoch += 1;
  };
  return { mlsService, state, accept };
}

const run = (mlsService: ReturnType<typeof createMlsServiceStub>) =>
  removeMemberAndBroadcast({
    mlsService,
    groupId: G,
    memberId: BOB,
    userId: ME,
    deviceKeyB64: 'k',
  });

describe('removeMemberAndBroadcast - a lost commit race', () => {
  beforeEach(() => {
    leadership.value = 'leader';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('REBUILDS the Remove on the epoch that beat it, and the tree ends without the member', async () => {
    const { mlsService, state, accept } = harness();
    vi.mocked(mlsService.removeMember)
      .mockImplementationOnce(async () => {
        // Another member's Add won epoch 3; the refusal's catch-up applied it.
        state.tree.push('user-c:d1');
        state.epoch = 4;
        throw new CommitRefusedError('epoch_mismatch', 3, 4);
      })
      .mockImplementationOnce(accept);

    await expect(run(mlsService)).resolves.toBe('committed');

    expect(mlsService.removeMember).toHaveBeenCalledTimes(2);
    expect(state.tree).toEqual([`${ME}:da`, 'user-c:d1']);
    expect(state.epoch).toBe(5);
    // The notice goes once the tree agrees with the roster.
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('commits nothing more when the commit that won had already removed the member', async () => {
    const { mlsService, state } = harness();
    vi.mocked(mlsService.removeMember).mockImplementationOnce(async () => {
      // Another holder's collector removed them at epoch 3.
      state.tree = [`${ME}:da`];
      state.epoch = 4;
      throw new CommitRefusedError('epoch_mismatch', 3, 4);
    });

    await expect(run(mlsService)).resolves.toBe('already-out');

    expect(mlsService.removeMember).toHaveBeenCalledTimes(1);
    expect(state.tree).toEqual([`${ME}:da`]);
  });

  it('CC-3: two Removes of one person - the loser, refused concurrent_commit, ends QUIETLY', async () => {
    // Two members remove BOB at once. The winner's commit holds the gate's lock, so the loser is
    // refused `concurrent_commit` with no epoch ahead to catch up on; the winner's commit reaches
    // the loser's tree before the refusal is read. Both tallies agree: BOB is off roster and tree.
    const { mlsService, state } = harness();
    const winner = harness();
    vi.mocked(winner.mlsService.removeMember).mockImplementation(winner.accept);
    vi.mocked(mlsService.removeMember).mockImplementationOnce(async () => {
      state.tree = [`${ME}:da`];
      state.epoch = 4;
      throw new CommitRefusedError('concurrent_commit', 3, 3);
    });
    const error = vi.spyOn(console, 'error');
    const warn = vi.mocked(console.warn);

    const [won, lost] = await Promise.all([run(winner.mlsService), run(mlsService)]);

    expect(won).toBe('committed');
    expect(lost).toBe('already-out');
    expect(winner.state.tree).toEqual([`${ME}:da`]);
    expect(state.tree).toEqual([`${ME}:da`]);
    // Quiet: no error, no warning, and no second "removed" notice from the loser.
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(winner.mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('a concurrent_commit refusal while the member STILL holds a leaf is surfaced, never quiet', async () => {
    const { mlsService, state } = harness();
    vi.mocked(mlsService.removeMember).mockRejectedValue(
      new CommitRefusedError('concurrent_commit', 3, 3)
    );

    await expect(run(mlsService)).rejects.toBeInstanceOf(MemberRemovalNotCommittedError);
    expect(state.tree).toContain(`${BOB}:d1`);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('NOT committed'));
  });

  it('rebuilds on an overtaken seat claim, which refuses the whole commit without moving the epoch', async () => {
    const { mlsService, state, accept } = harness();
    vi.mocked(mlsService.removeMember)
      .mockRejectedValueOnce(new CommitRefusedError(SEAT_CLAIM_OVERTAKEN_REASON, 3, 3))
      .mockImplementationOnce(accept);

    await run(mlsService);

    expect(mlsService.removeMember).toHaveBeenCalledTimes(2);
    expect(state.tree).toEqual([`${ME}:da`]);
  });

  it('SURFACES a refusal that moved nothing as the typed error - recorded, not committed', async () => {
    const { mlsService, state } = harness();
    vi.mocked(mlsService.removeMember).mockRejectedValue(
      new CommitRefusedError('epoch_mismatch', 3, 4)
    );

    const err = await run(mlsService).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MemberRemovalNotCommittedError);
    expect((err as MemberRemovalNotCommittedError).memberId).toBe(BOB);
    // No proof of progress, so no second attempt - the loop ends on a proof, never a count.
    expect(mlsService.removeMember).toHaveBeenCalledTimes(1);
    expect(mlsService.removeMemberFromServer).toHaveBeenCalledWith(G, BOB);
    expect(state.tree).toContain(`${BOB}:d1`);
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('surfaces an unknown commit outcome as the typed error, and never rebuilds over it', async () => {
    const { mlsService } = harness();
    vi.mocked(mlsService.removeMember).mockRejectedValue(
      new CommitOutcomeUnknownError(G, 3, new Error('timeout'))
    );

    await expect(run(mlsService)).rejects.toBeInstanceOf(MemberRemovalNotCommittedError);
    expect(mlsService.removeMember).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unreadable tree as the typed error, with nothing staged', async () => {
    const { mlsService } = harness();
    vi.mocked(mlsService.getGroupMemberIdentities).mockRejectedValue(new Error('wasm'));

    await expect(run(mlsService)).rejects.toBeInstanceOf(MemberRemovalNotCommittedError);
    expect(mlsService.removeMember).not.toHaveBeenCalled();
  });

  it('a member who holds no leaf is removed from the roster and nothing is staged', async () => {
    const { mlsService, state } = harness();
    state.tree = [`${ME}:da`];

    await expect(run(mlsService)).resolves.toBe('already-out');

    expect(mlsService.removeMemberFromServer).toHaveBeenCalledWith(G, BOB);
    expect(mlsService.removeMember).not.toHaveBeenCalled();
  });

  it('a FOLLOWER tab is refused before the server record - never half-removed', async () => {
    leadership.value = 'follower';
    const { mlsService } = harness();

    await expect(run(mlsService)).rejects.toBeInstanceOf(FollowerTabCommitError);
    expect(mlsService.removeMemberFromServer).not.toHaveBeenCalled();
    expect(mlsService.removeMember).not.toHaveBeenCalled();
  });
});

describe('rebuildableRefusal - the one rule a lost race is rebuilt on', () => {
  it('rebuilds a refusal whose catch-up moved the epoch', () => {
    expect(rebuildableRefusal(new CommitRefusedError('epoch_mismatch', 3, 4), 3, 4)).toBe(
      'epoch-moved'
    );
  });

  it('rebuilds an overtaken seat claim, whose epoch stood still', () => {
    expect(
      rebuildableRefusal(new CommitRefusedError(SEAT_CLAIM_OVERTAKEN_REASON, 3, 3), 3, 3)
    ).toBe('seat-claim-overtaken');
  });

  it('refuses a refusal that moved nothing, and anything that is not a refusal', () => {
    expect(rebuildableRefusal(new CommitRefusedError('epoch_mismatch', 3, 4), 3, 3)).toBeNull();
    expect(
      rebuildableRefusal(new CommitRefusedError('rate_limited', 3, undefined), 3, 3)
    ).toBeNull();
    // Its text is not its type.
    expect(
      rebuildableRefusal(new Error('Staged commit rejected: epoch_mismatch'), 3, 4)
    ).toBeNull();
  });
});
