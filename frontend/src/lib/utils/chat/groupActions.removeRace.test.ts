// @vitest-environment happy-dom
const leadership = vi.hoisted(() => ({ value: 'leader' as 'leader' | 'follower' | 'undecided' }));
vi.mock('$lib/mls-client/tabLeader', () => ({ getTabLeadership: () => leadership.value }));
// The acting device's own notice resolves names: a profile read nothing here is about.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveDisplayNames: async () => (id: string) => id,
}));

import { removeMemberAndBroadcast } from './groupActions';
import { MemberRemovalNotCommittedError } from './memberRemovalError';
import type { NoticeWriter } from './visibleNotices';
import { decodeAppMessage } from '$lib/proto/codec';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import {
  COMMIT_LOCK_BUDGET_SPENT_REASON,
  CommitRefusedError,
  SEAT_CLAIM_OVERTAKEN_REASON,
  rebuildableRefusal,
} from '$lib/mls-client/CommitRefusedError';
import {
  CommitOutcomeUnknownError,
  FollowerTabCommitError,
} from '$lib/mls-client/commitSubmission';

/**
 * A REMOVE THAT LOSES THE COMMIT RACE ENDS REBUILT, QUIETLY SATISFIED, OR SURFACED - NEVER LOGGED
 * ALONE (CC-2, CC-3, 1.4.1 dev campaign, 2026-10-25). The member is already off the roster when the
 * commit is built, so a failure swallowed into a log line left them off the roster and in the tree
 * with nobody told. Each test models the gate on a small in-memory tree and commit log: the roster
 * and the tree must agree at the end, or the caller must hold the typed error that says they do not.
 * `groupActions.removeRace.realCommit.test.ts` drives the same cases through the REAL commit path.
 */
const G = 'group-1';
const BOB = 'user-b';
const ME = 'user-a';

/** A group whose tree and epoch move the way the gate and a catch-up move them. */
function harness() {
  const mlsService = createMlsServiceStub();
  const state = {
    epoch: 3,
    tree: [`${ME}:da`, `${BOB}:d1`, `${BOB}:d2`],
    /** Commits the server holds past the local epoch, applied in order by a replay. */
    serverAhead: [] as Array<(tree: string[]) => string[]>,
  };
  vi.mocked(mlsService.getEpoch).mockImplementation(() => state.epoch);
  vi.mocked(mlsService.getGroupMemberIdentities).mockImplementation(async () => [...state.tree]);
  vi.mocked(mlsService.fetchCommitsSince).mockImplementation(async (_g, since) => ({
    commits: state.serverAhead.map((_, i) => ({ baseEpoch: since + i, proto: 'AQID' })),
    activeEpoch: state.epoch + state.serverAhead.length,
    belowFloor: false,
  }));
  vi.mocked(mlsService.processIncomingMessage).mockImplementation(async () => {
    const next = state.serverAhead.shift();
    if (next) state.tree = next(state.tree);
    state.epoch += 1;
    return null;
  });
  const accept = async (_g: string, userIds: string[]) => {
    state.tree = state.tree.filter((leaf) => !userIds.some((u) => leaf.startsWith(`${u}:`)));
    state.epoch += 1;
  };
  return { mlsService, state, accept };
}

/** Where the acting device writes its own `memberRemoved` row; reset per test. */
let ownWriter = vi.fn<NoticeWriter>(async () => {});

const run = (mlsService: ReturnType<typeof createMlsServiceStub>) =>
  removeMemberAndBroadcast({
    mlsService,
    groupId: G,
    memberId: BOB,
    userId: ME,
    deviceKeyB64: 'k',
    ownNotice: { contactName: G, addMessageToChat: ownWriter },
  });

/** The id the one `memberRemoved` frame sent carries - the id every member's device writes. */
function sentNoticeId(mlsService: ReturnType<typeof createMlsServiceStub>): string {
  const frames = vi
    .mocked(mlsService.sendMessage)
    .mock.calls.map((call) => decodeAppMessage(call[1] as Uint8Array));
  expect(frames).toHaveLength(1);
  expect(frames[0]?.system?.event).toBe('memberRemoved');
  return frames[0]!.messageId!;
}

describe('removeMemberAndBroadcast - a lost commit race', () => {
  beforeEach(() => {
    leadership.value = 'leader';
    ownWriter = vi.fn<NoticeWriter>(async () => {});
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
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    // The acting device holds the notice it sent, under the frame's own id.
    expect(ownWriter).toHaveBeenCalledTimes(1);
    expect(ownWriter.mock.calls[0][3]).toMatchObject({
      isSystem: true,
      messageId: sentNoticeId(mlsService),
    });
  });

  it('commits nothing more when the commit that won had already removed the member', async () => {
    const { mlsService, state } = harness();
    vi.mocked(mlsService.removeMember).mockImplementationOnce(async () => {
      state.tree = [`${ME}:da`];
      state.epoch = 4;
      throw new CommitRefusedError('epoch_mismatch', 3, 4);
    });

    await expect(run(mlsService)).resolves.toBe('already-out');

    expect(mlsService.removeMember).toHaveBeenCalledTimes(1);
    // The winner announced it; the loser does not say it twice - nor write a row of its own.
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
    expect(ownWriter).not.toHaveBeenCalled();
  });

  it('CC-3: the STAGE finds no leaf (a plain error, epoch unchanged) - the loser ends QUIETLY', async () => {
    // Two members remove BOB at once. The loser saw BOB, then waited for the MLS lock while the
    // winner's Remove was applied under it; its stage fails in the platform with an untyped error.
    const { mlsService, state } = harness();
    vi.mocked(mlsService.removeMember).mockImplementationOnce(async () => {
      state.tree = [`${ME}:da`];
      throw new Error(`NoSuchMember("no leaf carries any of the identities [\\"${BOB}\\"]")`);
    });
    const error = vi.spyOn(console, 'error');

    await expect(run(mlsService)).resolves.toBe('already-out');

    expect(state.tree).toEqual([`${ME}:da`]);
    expect(error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(mlsService.sendMessage).not.toHaveBeenCalled();
  });

  it('CC-3: refused concurrent_commit while the winner was applied - quiet as well', async () => {
    const { mlsService, state } = harness();
    vi.mocked(mlsService.removeMember).mockImplementationOnce(async () => {
      state.tree = [`${ME}:da`];
      throw new CommitRefusedError('concurrent_commit', 3, 3);
    });

    await expect(run(mlsService)).resolves.toBe('already-out');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('a refusal while the member STILL holds a leaf is surfaced, and the notice still goes', async () => {
    const { mlsService, state } = harness();
    vi.mocked(mlsService.removeMember).mockRejectedValue(
      new CommitRefusedError('concurrent_commit', 3, 3)
    );

    const err = await run(mlsService).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MemberRemovalNotCommittedError);
    expect((err as MemberRemovalNotCommittedError).why).toBe('commit-not-landed');
    // No proof of progress, so no second attempt - the loop ends on a proof, never a count.
    expect(mlsService.removeMember).toHaveBeenCalledTimes(1);
    expect(state.tree).toContain(`${BOB}:d1`);
    // The record IS the removal: its notice follows it even though the commit did not land, and
    // the acting device holds it too, under the frame's id.
    expect(mlsService.sendMessage).toHaveBeenCalledTimes(1);
    expect(ownWriter.mock.calls[0]?.[3]).toMatchObject({ messageId: sentNoticeId(mlsService) });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('NOT committed'));
  });

  it('a tree BEHIND the server is caught up before "out" is believed - the re-added member is removed', async () => {
    const { mlsService, state, accept } = harness();
    // Locally BOB is gone, but the server holds an Add (epoch 3 -> 4) that brought them back.
    state.tree = [`${ME}:da`];
    state.serverAhead = [(tree) => [...tree, `${BOB}:d3`]];
    vi.mocked(mlsService.removeMember).mockImplementationOnce(accept);

    await expect(run(mlsService)).resolves.toBe('committed');

    expect(mlsService.processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(state.tree).toEqual([`${ME}:da`]);
  });

  it('a tree that cannot be brought to the server epoch is NOT "out" - surfaced as unconfirmed', async () => {
    const { mlsService, state } = harness();
    state.tree = [`${ME}:da`];
    state.serverAhead = [(tree) => [...tree, `${BOB}:d3`]];
    vi.mocked(mlsService.processIncomingMessage).mockRejectedValue(new Error('wrong epoch'));

    const err = await run(mlsService).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MemberRemovalNotCommittedError);
    expect((err as MemberRemovalNotCommittedError).why).toBe('tree-unconfirmed');
    expect(mlsService.removeMember).not.toHaveBeenCalled();
  });

  it('rebuilds on an overtaken seat claim, which refuses the whole commit without moving the epoch', async () => {
    const { mlsService, state, accept } = harness();
    vi.mocked(mlsService.removeMember)
      .mockRejectedValueOnce(new CommitRefusedError(SEAT_CLAIM_OVERTAKEN_REASON, 3, 3))
      .mockImplementationOnce(accept);

    await expect(run(mlsService)).resolves.toBe('committed');

    expect(mlsService.removeMember).toHaveBeenCalledTimes(2);
    expect(state.tree).toEqual([`${ME}:da`]);
  });

  it('surfaces an unknown commit outcome without reading the tree, and never rebuilds over it', async () => {
    const { mlsService } = harness();
    vi.mocked(mlsService.removeMember).mockRejectedValue(
      new CommitOutcomeUnknownError(G, 3, new Error('timeout'))
    );

    await expect(run(mlsService)).rejects.toBeInstanceOf(MemberRemovalNotCommittedError);
    expect(mlsService.removeMember).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unreadable tree as unconfirmed, with nothing staged', async () => {
    const { mlsService } = harness();
    vi.mocked(mlsService.getGroupMemberIdentities).mockRejectedValue(new Error('wasm'));

    const err = await run(mlsService).catch((e: unknown) => e);
    expect((err as MemberRemovalNotCommittedError).why).toBe('tree-unconfirmed');
    expect(mlsService.removeMember).not.toHaveBeenCalled();
  });

  it('a member who holds no leaf at the server epoch is removed from the roster, nothing staged', async () => {
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
  it('rebuilds a refusal whose catch-up moved the epoch past the RECORDED base', () => {
    expect(rebuildableRefusal(new CommitRefusedError('epoch_mismatch', 3, 4), 4)).toBe(
      'epoch-moved'
    );
    expect(rebuildableRefusal(new CommitRefusedError('concurrent_commit', 3, 3), 4)).toBe(
      'epoch-moved'
    );
  });

  it('rebuilds an overtaken seat claim, whose epoch stood still', () => {
    expect(rebuildableRefusal(new CommitRefusedError(SEAT_CLAIM_OVERTAKEN_REASON, 3, 3), 3)).toBe(
      'seat-claim-overtaken'
    );
  });

  it('refuses a refusal that moved nothing, a refusal the client decided, and anything else', () => {
    expect(rebuildableRefusal(new CommitRefusedError('epoch_mismatch', 3, 4), 3)).toBeNull();
    // Not races, whatever the epoch did meanwhile.
    expect(rebuildableRefusal(new CommitRefusedError('rate_limited', 3, undefined), 5)).toBeNull();
    expect(
      rebuildableRefusal(new CommitRefusedError(COMMIT_LOCK_BUDGET_SPENT_REASON, 3, undefined), 5)
    ).toBeNull();
    // Its text is not its type.
    expect(rebuildableRefusal(new Error('Staged commit rejected: epoch_mismatch'), 4)).toBeNull();
  });
});
