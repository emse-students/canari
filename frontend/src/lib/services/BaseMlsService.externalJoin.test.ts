// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

// The durability half of a join, stubbed so the ORDER and the FACT of the checkpoint are readable.
// Mocked rather than driven through a real persister because what is under test here is that
// `externalJoin` asks for it and waits, not what the persister then does with the request.
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import {
  keyPackageWaitFields,
  publishedKeyPackageAnswer,
} from './BaseMlsService.keyPackageFixture';
import { persistMlsStructuralCheckpoint } from '$lib/mls-client/mlsStatePersisterRegistry';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import type { ExternalJoinOutcome } from '$lib/mls-client/IMlsService';
import { MlsStateWriteRefusedError } from '$lib/utils/hex';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { resetCommitRateLimit } from '$lib/mls-client/commitRateLimit';

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
      fetchDeviceKeyPackage: vi.fn(async () => publishedKeyPackageAnswer()),
      fetchGroupInfo: vi.fn(),
      submitCommit: vi.fn(),
      storeGroupInfo: vi.fn().mockResolvedValue(undefined),
    },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    // The groups this device holds, read by `externalJoin` under the lock. Empty: a joiner.
    getLocalGroups: vi.fn((): string[] => []),
    // The REAL routing method, not a stand-in: `externalJoin` no longer reaches the delivery client
    // directly, and a stub reproducing that hop here would keep passing after the real one broke.
    groupInfoChannel: (
      BaseMlsService.prototype as unknown as {
        groupInfoChannel: (groupId: string) => unknown;
      }
    ).groupInfoChannel,
    distributionScopeByGroup: new Map<string, string>(),
    knownDistributionGroups: new Set<string>(),
    distributionGroupInfo: null,
    joinByExternalCommit: vi.fn().mockResolvedValue({ groupId: 'g', commit: new Uint8Array([9]) }),
    // The epoch the fake instance reaches once the external commit is applied to it. `externalJoin`
    // refuses to publish a base that is not for `gi.baseEpoch + 1`, so any test that builds a commit
    // has to say which epoch it landed on; 6 matches the base-5 GroupInfo most of them serve.
    getEpoch: vi.fn(() => 6),
    exportGroupInfo: vi.fn().mockResolvedValue(new Uint8Array([7, 7])),
    // The REAL atomic read, for the same reason `groupInfoChannel` is real: `externalJoin` no
    // longer exports the base itself, and a stub reproducing that hop here would keep passing
    // after the shared one broke.
    exportBaseForPublication: (
      BaseMlsService.prototype as unknown as {
        exportBaseForPublication: (groupId: string) => Promise<{ base: string; baseEpoch: number }>;
      }
    ).exportBaseForPublication,
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    // The key the merged commit gives this device's leaf, which the ledger names it by.
    ownLeafKey: vi.fn(async () => 'k-leaf'),
    noteOwnLeafReplaced: (BaseMlsService.prototype as unknown as Record<string, unknown>)
      .noteOwnLeafReplaced,
    refreshGroupInfo: vi.fn().mockResolvedValue(null),
    forgetGroup: vi.fn(),
    ...keyPackageWaitFields(),
    ...overrides,
  };
}

const externalJoin = (ctx: unknown, groupId: string): Promise<ExternalJoinOutcome> =>
  (
    BaseMlsService.prototype.externalJoin as unknown as (g: string) => Promise<ExternalJoinOutcome>
  ).call(ctx, groupId);

describe('BaseMlsService.externalJoin', () => {
  // The registry mock is module-scoped, so an implementation set by one case would otherwise be the
  // starting state of every case after it - including the ones that assert it was never called.
  beforeEach(() => {
    vi.mocked(persistMlsStructuralCheckpoint).mockReset().mockResolvedValue(true);
  });

  it('reports no published base, without joining, when nothing is stored', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue(null);

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: false, reason: 'no_base_published' });
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
  });

  /**
   * AN EXTERNAL JOIN IS A COMMIT, so a follower tab refuses it as `runCommitTransaction` does: the
   * tree it would join into is a copy no disk and no other tab follows.
   */
  it('refuses on a follower tab, before fetching or building anything', async () => {
    const leadership = await import('$lib/mls-client/tabLeader');
    vi.spyOn(leadership, 'getTabLeadership').mockReturnValue('follower');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = makeCtx();

    await expect(externalJoin(ctx, 'g')).rejects.toBeInstanceOf(FollowerTabCommitError);
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
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

  // ── The half the server already made durable for everybody else ─────────────
  //
  // AN ACCEPTED EXTERNAL COMMIT IS ASYMMETRICALLY DURABLE. The epoch advance is written server-side
  // and visible to every other member the instant `submitCommit` returns; the secrets that make the
  // new epoch usable exist only in this device's WASM memory until a checkpoint lands. A reload in
  // that window restores a device that is IN the published tree, can read nothing in it, finds no
  // local group - and joins AGAIN, forking the group at the next base.
  //
  // Measured on prod 2026-08-27: one device joined a salon at base 0 and again at base 1 two
  // seconds apart across a navigation. The salon reached epoch 2, the granting device stayed at 0
  // refusing frames it had no tree for, and the seed it held never reached the member it had just
  // granted - COMM-8's `seedAfterTheGrant: false`.
  //
  // The routine persister defers writes for a reason it documents in full: inbound state replays
  // from the server, outbound ratchet state is checkpointed on the send path. A join is neither,
  // which is why this one is awaited rather than scheduled.

  it('checkpoints the joined state before reporting the join, and after the merge', async () => {
    const ctx = makeCtx();
    const order: string[] = [];
    ctx.mergePendingCommit.mockImplementation(async () => {
      order.push('merge');
    });
    vi.mocked(persistMlsStructuralCheckpoint).mockImplementation(async () => {
      order.push('checkpoint');
      return true;
    });
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true, newEpoch: 6 });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    // MERGE FIRST, THEN WRITE. Checkpointing an unmerged external commit would persist a pending
    // state that breaks every later operation on the group - the opposite fault, and a worse one.
    expect(order).toEqual(['merge', 'checkpoint']);
  });

  it('still reports the join when the checkpoint fails, because the group can already see it', async () => {
    const ctx = makeCtx();
    vi.mocked(persistMlsStructuralCheckpoint).mockRejectedValue(new Error('quota exceeded'));
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true, newEpoch: 6 });

    // The membership is real and server-side: refusing it here would discard a leaf every other
    // member already holds, which is strictly worse than a membership that does not survive a
    // reload. What the failure costs is durability, and that is what the log has to say.
    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    expect(ctx.forgetGroup).not.toHaveBeenCalled();
  });

  // A STALE WRITE IS ONLY A FAILURE WHEN THE STORED BLOB IS ANOTHER DOCUMENT'S (2026-10-21). A direct
  // `persistCheckpoint` landing before the persister's flight makes that flight older than the store;
  // the newer blob is this document's own and holds the join, so the checkpoint resolves
  // (`writeCheckpoint` on `superseded`) and the fork accusation below must not be printed. Against
  // another tab's blob the checkpoint rejects typed, and the accusation is exactly right.
  it.each([
    ['superseded by its own later capture', null, false],
    ["refused behind another document's blob", new MlsStateWriteRefusedError('stale'), true],
  ] as const)('a join whose checkpoint was %s', async (_c, refusal, accuses) => {
    const ctx = makeCtx();
    if (refusal) vi.mocked(persistMlsStructuralCheckpoint).mockRejectedValue(refusal);
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true, newEpoch: 6 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    const accused = error.mock.calls.some((c) => String(c[0]).includes('FAILED to checkpoint'));
    error.mockRestore();
    expect(accused).toBe(accuses);
  });

  it('does not checkpoint a join the gate refused', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: false, reason: 'epoch_mismatch' });

    await externalJoin(ctx, 'g');
    // A refused commit is discarded with `forgetGroup`; writing it to disk would durably persist a
    // group this device is not in, and the next load would trust it.
    expect(persistMlsStructuralCheckpoint).not.toHaveBeenCalled();
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g', 0);
  });

  it('discards and retries with a fresher GroupInfo on an epoch-race reject, then succeeds', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo
      .mockResolvedValueOnce({ groupInfo: 'AA==', baseEpoch: 5, activeEpoch: 5 })
      .mockResolvedValueOnce({ groupInfo: 'AA==', baseEpoch: 6, activeEpoch: 6 });
    ctx.delivery.submitCommit
      .mockResolvedValueOnce({ accepted: false, reason: 'epoch_mismatch', currentEpoch: 6 })
      .mockResolvedValueOnce({ accepted: true, newEpoch: 7 });
    // ONE EPOCH PER ATTEMPT, AND IT IS THE BUILD THAT MOVES IT - not the number of times anybody
    // reads it. The base-5 commit lands the instance on 6 and the base-6 one on 7. Counting reads
    // instead tied this fixture to how often `getEpoch` is called, which is the publisher's
    // business and not the join's: reading the epoch either side of the export, to prove the blob
    // and its number come from the same tree, would have "failed" this case for no reason.
    let epoch = 5;
    ctx.getEpoch.mockImplementation(() => epoch);
    ctx.joinByExternalCommit.mockImplementation(async () => {
      epoch += 1;
      return { groupId: 'g', commit: new Uint8Array([9]) };
    });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    // The rejected external commit cannot be cleared -> the group is discarded before the retry.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g', 0);
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
    ctx.joinByExternalCommit.mockRejectedValue(new Error('join_by_external_commit: InvalidData'));

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: false, reason: 'build_failed' });
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();
  });

  /**
   * THE TWO-WELCOME INTERLEAVING (review of #2466). A recovery started by one failed Welcome reaches
   * the join after the drain applied a SECOND Welcome for the group, under the lock the join waits
   * for. Building over the held group wrote OpenMLS's external-join group into the live group's
   * storage rows, and the refusal that followed was read as `build_failed` - which asks a member to
   * re-add a device whose leaf is healthy. Held when the lock is taken means joined, nothing built.
   */
  it('stands down, building nothing, when a Welcome installed the group while it waited for the lock', async () => {
    const held: string[] = [];
    const ctx = makeCtx({
      getLocalGroups: vi.fn(() => held),
      // The drain holds the lock first and applies the second Welcome; the join runs after it.
      runUnderMlsLock: async <T>(fn: () => Promise<T>) => {
        held.push('g');
        return fn();
      },
    });
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true, alreadyHeld: true });
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();
    expect(ctx.forgetGroup).not.toHaveBeenCalled();
  });

  it("reads the engine's typed refusal of a held group as joined, and accuses the list that missed it", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.joinByExternalCommit.mockRejectedValue(new Error('GROUP_ALREADY_HELD: g'));

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true, alreadyHeld: true });
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('did not say so'));
    error.mockRestore();
  });

  it('never reads a refusal naming ANOTHER held group as joined for this one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.joinByExternalCommit.mockRejectedValue(new Error('GROUP_ALREADY_HELD: other-group'));

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: false, reason: 'build_failed' });
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('the served base is for another group')
    );
    error.mockRestore();
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
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g', 0);
    expect(ctx.mergePendingCommit).not.toHaveBeenCalled();
  });

  // A 429 IS AN ANSWER, and the wait it names holds for every group of this account: the join
  // reports it typed, and the next join does not even build a commit until it has passed.
  it('reports a rate-limited join with its wait, and builds nothing more while the wait holds', async () => {
    resetCommitRateLimit();
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockRejectedValue(
      new ApiRefusalError(429, 'RATE_LIMITED', 'Commit submission HTTP error (429)', {
        retryAfterMs: 20_000,
      })
    );

    const first = await externalJoin(ctx, 'g');
    expect(first).toMatchObject({ joined: false, reason: 'rate_limited' });
    expect((first as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(19_000);
    // Refused before the gate: the commit was built in memory and is dropped, never retried.
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g', 0);

    const other = makeCtx();
    expect(await externalJoin(other, 'g2')).toMatchObject({
      joined: false,
      reason: 'rate_limited',
    });
    expect(other.joinByExternalCommit).not.toHaveBeenCalled();
    expect(other.delivery.submitCommit).not.toHaveBeenCalled();
    resetCommitRateLimit();
  });

  // A 409 SEAT_CLAIM_OVERTAKEN IS AN ANSWER TOO: someone else's eviction moved the group's seat
  // generation while the server asked whether this device may join, so nothing advanced and the
  // retry meets a fresh claim. Each refusal proves an eviction happened, which is what bounds it.
  it('retries at once when an unrelated eviction overtook its seat claim, and joins', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit
      .mockRejectedValueOnce(
        new ApiRefusalError(409, 'SEAT_CLAIM_OVERTAKEN', 'Commit submission HTTP error (409)')
      )
      .mockResolvedValueOnce({ accepted: true, newEpoch: 6 });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(2);
    // The refused external commit cannot be cleared, so its group goes before the retry builds anew.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g', 0);
    expect(ctx.mergePendingCommit).toHaveBeenCalledTimes(1);
  });

  it('reports a seat claim overtaken on every attempt as a typed refusal', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({
      groupInfo: 'AA==',
      baseEpoch: 5,
      activeEpoch: 5,
    });
    ctx.delivery.submitCommit.mockRejectedValue(
      new ApiRefusalError(409, 'SEAT_CLAIM_OVERTAKEN', 'Commit submission HTTP error (409)')
    );

    expect(await externalJoin(ctx, 'g')).toEqual({
      joined: false,
      reason: 'refused',
      serverReason: 'seat_claim_overtaken',
    });
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(3);
  });
});
