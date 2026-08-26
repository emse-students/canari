// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import type { ExternalJoinOutcome } from '$lib/mls-client/IMlsService';

/**
 * Unit-tests the external-join ORCHESTRATION (Phase 4a) in isolation: fetch GroupInfo -> build the
 * external commit -> submit under the epoch gate -> merge (accept) or forget + retry (reject).
 * The crypto round-trip itself is covered by the mls-core integration test; here we drive the
 * BaseMlsService method against stubbed primitives via `.call` to avoid a full concrete subclass.
 *
 * EVERY OUTCOME IS CHECKED BY ITS REASON, not by a boolean, because the reason is the whole point:
 * five causes used to arrive at every caller as one `false`, and the retry loop written for the one
 * that can change was taken for the four that cannot.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u',
    deviceId: 'd',
    delivery: {
      fetchGroupInfo: vi.fn(),
      submitCommit: vi.fn(),
      storeGroupInfo: vi.fn().mockResolvedValue(undefined),
    },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    // The REAL routing method, not a stand-in: `externalJoin` no longer reaches the delivery client
    // directly, and a stub reproducing that hop here would keep passing after the real one broke.
    groupInfoChannel: (
      BaseMlsService.prototype as unknown as {
        groupInfoChannel: (groupId: string) => unknown;
      }
    ).groupInfoChannel,
    distributionScopeByGroup: new Map<string, string>(),
    distributionGroupInfo: null,
    joinByExternalCommit: vi.fn().mockResolvedValue({ groupId: 'g', commit: new Uint8Array([9]) }),
    // The epoch the fake instance reaches once the external commit is applied to it. `externalJoin`
    // refuses to publish a base that is not for `gi.baseEpoch + 1`, so any test that builds a commit
    // has to say which epoch it landed on; 6 matches the base-5 GroupInfo most of them serve.
    getEpoch: vi.fn(() => 6),
    exportGroupInfo: vi.fn().mockResolvedValue(new Uint8Array([7, 7])),
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    refreshGroupInfo: vi.fn().mockResolvedValue(undefined),
    forgetGroup: vi.fn(),
    ...overrides,
  };
}

const externalJoin = (ctx: unknown, groupId: string): Promise<ExternalJoinOutcome> =>
  (
    BaseMlsService.prototype.externalJoin as unknown as (g: string) => Promise<ExternalJoinOutcome>
  ).call(ctx, groupId);

describe('BaseMlsService.externalJoin', () => {
  it('reports no published base, without joining, when nothing is stored', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue(null);

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: false, reason: 'no_base_published' });
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
  });

  // ── The refusal that must not become a `false` ──────────────────────────────
  //
  // THE MIDDLE LINK OF THE CHAIN. `fetchGroupInfo` types its 403 and `requestReAdd` terminates on
  // the type; between them sat a `.catch(() => null)` that turned the answer into "nothing stored
  // yet" - the one state whose correct response is to retry. Both ends can be green while this hop
  // silently drops the distinction, which is exactly the shape the bug had.

  it('lets a membership refusal through instead of reporting no base', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockRejectedValue(new NotAGroupMemberError('g'));

    const err = await externalJoin(ctx, 'g').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotAGroupMemberError);
    // And it does not spend three attempts on an answer that cannot change.
    expect(ctx.delivery.fetchGroupInfo).toHaveBeenCalledTimes(1);
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
  });

  it('still reports no base for a failure that says nothing about membership', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockRejectedValue(new Error('GroupInfo fetch HTTP error: 503'));

    // The welcome_request fallback lives on this outcome, so an outage must keep reaching it.
    expect(await externalJoin(ctx, 'g')).toEqual({ joined: false, reason: 'no_base_published' });
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
  });

  // The claim `externalJoin`'s doc makes about its own blast radius, tested rather than asserted:
  // a distribution group is routed to its own transport by the REAL `groupInfoChannel` this harness
  // installs, so it never touches the membership-gated endpoint and cannot raise that refusal.
  it('routes a distribution group away from the membership-gated endpoint entirely', async () => {
    const ctx = makeCtx({
      distributionScopeByGroup: new Map([['g', 'community']]),
      distributionGroupInfo: {
        fetch: vi.fn().mockResolvedValue({ groupInfo: 'AA==', baseEpoch: 3, activeEpoch: 3 }),
        publish: vi.fn().mockResolvedValue({ stored: true }),
      },
      getEpoch: vi.fn(() => 4),
    });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
  });

  it('joins, submits against the base epoch, merges and succeeds on accept', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true, newEpoch: 6 });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    // Submitted with the GroupInfo's base epoch and excluding our own device from the fan-out.
    expect(ctx.delivery.submitCommit).toHaveBeenCalledWith(
      'g',
      5,
      expect.any(String),
      ['u:d'],
      'Bwc='
    );
    expect(ctx.mergePendingCommit).toHaveBeenCalledWith('g');
    expect(ctx.forgetGroup).not.toHaveBeenCalled();
  });

  it('discards and retries with a fresher GroupInfo on an epoch-race reject, then succeeds', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo
      .mockResolvedValueOnce({ groupInfo: 'AA==', baseEpoch: 5, activeEpoch: 5 })
      .mockResolvedValueOnce({ groupInfo: 'AA==', baseEpoch: 6, activeEpoch: 6 });
    ctx.delivery.submitCommit
      .mockResolvedValueOnce({ accepted: false, reason: 'epoch_mismatch', currentEpoch: 6 })
      .mockResolvedValueOnce({ accepted: true, newEpoch: 7 });
    // One epoch per attempt: the base 5 commit lands on 6, the base 6 one on 7.
    ctx.getEpoch.mockReturnValueOnce(6).mockReturnValue(7);

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    // The rejected external commit cannot be cleared -> the group is discarded before the retry.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g');
    expect(ctx.delivery.fetchGroupInfo).toHaveBeenCalledTimes(2);
    expect(ctx.mergePendingCommit).toHaveBeenCalledTimes(1);
  });

  it('reports a build failure separately from an absent base', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.joinByExternalCommit.mockRejectedValue(new Error('already present locally'));

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: false, reason: 'build_failed' });
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();
  });

  it('gives up after exhausting the bound on a persistently busy commit lock', async () => {
    const ctx = makeCtx();
    // `concurrent_commit` is the ONE refusal the bound exists for: the base genuinely may move by
    // the next read, and here it never does.
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockResolvedValue({
      accepted: false,
      reason: 'concurrent_commit',
      currentEpoch: 5,
    });

    expect(await externalJoin(ctx, 'g')).toEqual({
      joined: false,
      reason: 'refused',
      serverReason: 'concurrent_commit',
      serverEpoch: 5,
    });
    expect(ctx.forgetGroup).toHaveBeenCalledTimes(3);
  });

  // ── The defect this file exists for (COMM-8, production 2026-08-25) ─────────
  //
  // The base is published by a follow-up call from the device whose commit was just accepted, and
  // nothing else ever mints one. Lose that call and `activeEpoch` advances while the published base
  // does not - so the strict gate refuses every commit built on it, for ever. Retrying was not
  // merely useless: each attempt built and then discarded a fresh tree, and the same doomed commit
  // was still being submitted twenty minutes later.

  it('does not attempt a join at all when the published base is behind the group', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 1,
      activeEpoch: 2,
    });

    expect(await externalJoin(ctx, 'g')).toEqual({
      joined: false,
      reason: 'stale_base',
      baseEpoch: 1,
      serverEpoch: 2,
    });
    // The fact was available before any work was done, so none of it happens.
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();
    expect(ctx.forgetGroup).not.toHaveBeenCalled();
    expect(ctx.delivery.fetchGroupInfo).toHaveBeenCalledTimes(1);
  });

  it('stops on the stale-base fact rather than burning the remaining attempts', async () => {
    const ctx = makeCtx();
    // A base that looked current, a commit that landed between our read and our submit, and then
    // NOBODY republishing: exactly the production sequence. Termination is the refetched fact, not
    // the attempt count - one submission, not three.
    ctx.delivery.fetchGroupInfo
      .mockResolvedValueOnce({ groupInfo: 'AA==', baseEpoch: 1, activeEpoch: 1 })
      .mockResolvedValue({ groupInfo: 'AA==', baseEpoch: 1, activeEpoch: 2 });
    ctx.delivery.submitCommit.mockResolvedValue({
      accepted: false,
      reason: 'epoch_mismatch',
      currentEpoch: 2,
    });
    ctx.getEpoch.mockReturnValue(2);

    expect(await externalJoin(ctx, 'g')).toEqual({
      joined: false,
      reason: 'stale_base',
      baseEpoch: 1,
      serverEpoch: 2,
    });
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);
    expect(ctx.forgetGroup).toHaveBeenCalledTimes(1);
  });

  // -- COMM-22 (production 2026-08-26): the joiner's OWN commit is what strands the next one ------
  //
  // COMM-8 above fixed the READER: a joiner no longer burns attempts on a base that is behind. It
  // could not fix the WRITER, and the writer is where the gap comes from - an accepted external
  // commit advances the epoch, and the base for the new one was minted by a SEPARATE follow-up call.
  // An external joiner reloads by construction, so that call was the one thing certain to be lost:
  // 14 seconds later a holder's ordinary read repaired it, long after the next joiner had given up.
  // The base now travels inside the submission, so there is no second call left to lose.

  it('publishes the base its own commit creates inside the submission, not after it', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true, newEpoch: 6 });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    // Exported from the instance the external commit was applied to, BEFORE the merge - the only
    // moment this device holds the tree for epoch 6 and can describe it to a later joiner.
    expect(ctx.exportGroupInfo).toHaveBeenCalledWith('g');
    expect(ctx.delivery.submitCommit).toHaveBeenCalledWith(
      'g',
      5,
      expect.any(String),
      ['u:d'],
      'Bwc='
    );
    // AND NOTHING FOLLOWS IT. A fire-and-forget refresh here would be the very call whose loss the
    // defect was made of, so its absence is the assertion.
    expect(ctx.refreshGroupInfo).not.toHaveBeenCalled();
  });

  it('abandons the join rather than publishing a base for the wrong epoch', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    // The instance did not land where an external commit on base 5 must land. The published base is
    // monotonic and cannot be walked back, so a blob stored under the wrong epoch would strand the
    // group for good: the join goes instead, and the caller's welcome_request fallback takes over.
    ctx.getEpoch.mockReturnValue(9);

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: false, reason: 'build_failed' });
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
  });

  it('claims nothing about membership when the commit gate is never reached', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockRejectedValue(new Error('Commit submission HTTP error: 502'));

    // A TRANSPORT FAILURE IS NOT AN ANSWER: this used to be relabelled an epoch race and retried
    // against a server that had never been reached.
    expect(await externalJoin(ctx, 'g')).toEqual({ joined: false, reason: 'unreachable' });
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);
    // The staged external commit still goes - it cannot be cleared, and a pending one left unmerged
    // breaks every later operation on the group.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g');
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
  });
});
