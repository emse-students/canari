// @vitest-environment happy-dom
// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { DELIVERY, addressedKeyMaterial, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import { readLeafRefreshLedger } from '$lib/mls-client/leafRefresh';
import { UnpublishedBranchError } from '$lib/mls-client/publishedBranch';
import { FollowerTabCommitError } from '$lib/mls-client/commitSubmission';
import { clearEpochGap, isInEpochGap } from '$lib/utils/chat/epochGapRegistry';
import { recordingStage } from '../../test/recordingStage';
import { sealedFrame } from '$lib/mls-client/test/sealedFrame';
import type { AuthoredFrame } from '$lib/mls-client/mlsDeliveryApi';
import { plainCommitLock } from '$lib/mls-client/test/fixtures/plainCommitLock';

/** Any intent: the refresh only hands it on to its stage. */
const INTENT = new Uint8Array([9]);

/**
 * THE WIRING OF THE PERIODIC LEAF REFRESH INTO THE TWO SEAMS IT HANGS FROM.
 *
 * `leafRefresh.test.ts` owns the decision. These pin where it is reached from: every own commit the
 * server ACCEPTS dates the leaf (a Remove or an Add replaces it as surely as a refresh does), a
 * refused one does not, and only a durable conversation send asks whether a refresh is due - never
 * a seed and never transport traffic.
 */

const U = 'user-a';
const D = 'web-a';

type RunCommit = (
  g: string,
  stage: (intent: Uint8Array) => Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>,
  opts?: Record<string, unknown>
) => Promise<unknown>;
const runCommitTransaction = (
  BaseMlsService.prototype as unknown as { runCommitTransaction: RunCommit }
).runCommitTransaction;

function commitCtx(accepted: boolean) {
  const recorder = recordingStage(() => 5);
  return {
    recorder,
    pendingSubmission: recorder.pendingSubmission,
    userId: U,
    deviceId: D,
    delivery: {
      submitCommit: vi
        .fn()
        .mockResolvedValue(
          accepted ? { accepted: true } : { accepted: false, reason: 'concurrent_commit' }
        ),
    },
    ...plainCommitLock,
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    clearPendingCommit: vi.fn().mockResolvedValue(undefined),
    catchUpOnRefusedCommit: vi.fn().mockResolvedValue(undefined),
    // No staged commit kept in the state: every commit here is answered at once.
    groupsWithPendingCommit: vi.fn(async () => []),
    // The real ones: with no staged commit kept they settle nothing (see
    // `BaseMlsService.unresolvedCommit.test.ts` for the cases where they do).
    ...Object.fromEntries(
      [
        'settleUnresolvedLocked',
        'checkpointStageBeforeSend',
        'submitRecorded',
        'mergeAccepted',
        'resubmitUnresolved',
      ].map((name) => [
        name,
        (BaseMlsService.prototype as unknown as Record<string, unknown>)[name],
      ])
    ),
  };
}

const staged = async () => ({ commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) });

beforeEach(() => localStorage.clear());

describe('BaseMlsService - every accepted own commit dates the leaf', () => {
  it('records the epoch the accepted commit created', async () => {
    const ctx = commitCtx(true);
    await runCommitTransaction.call(ctx, 'g-1', ctx.recorder.wrap(staged), {});
    expect(readLeafRefreshLedger(U, D)['g-1']).toMatchObject({ epoch: 6 });
  });

  it('records nothing for a refused commit - the leaf did not change', async () => {
    const ctx = commitCtx(false);
    await expect(
      runCommitTransaction.call(ctx, 'g-1', ctx.recorder.wrap(staged), {})
    ).rejects.toThrow();
    expect(readLeafRefreshLedger(U, D)['g-1']).toBeUndefined();
  });
});

describe('the commits no person asks for - staged only on the branch the server publishes', () => {
  const GI = 'Zm9v'; // any base64: the comparison is stubbed

  function branchCtx(opts: {
    base: { groupInfo: string; baseEpoch: number; activeEpoch: number } | null;
    matches?: boolean;
  }) {
    const stagedCommit = { commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) };
    const run = vi.fn(
      async (_g: string, stage: (intent: Uint8Array) => Promise<unknown>, _opts?: unknown) => {
        await stage(INTENT);
        return {};
      }
    );
    return {
      delivery: { fetchGroupInfo: vi.fn().mockResolvedValue(opts.base) },
      freshEpoch: vi.fn().mockResolvedValue(5),
      ownContextMatchesBase: vi.fn().mockResolvedValue(opts.matches ?? true),
      runCommitTransaction: run,
      stageSelfUpdate: vi.fn().mockResolvedValue(stagedCommit),
      stageRemoveMembersByDevice: vi.fn().mockResolvedValue(stagedCommit),
      assertOnPublishedBranch: (
        BaseMlsService.prototype as unknown as { assertOnPublishedBranch: unknown }
      ).assertOnPublishedBranch,
    };
  }
  const proto = BaseMlsService.prototype as unknown as {
    refreshOwnLeaf(g: string): Promise<void>;
    removeMemberDevice(g: string, ids: string[]): Promise<void>;
  };
  const REVOKED = ['user-b:dev-lost'];
  const commits = [
    ['the leaf refresh', (ctx: object) => proto.refreshOwnLeaf.call(ctx, 'g-1'), 'stageSelfUpdate'],
    [
      'the removal of a revoked device',
      (ctx: object) => proto.removeMemberDevice.call(ctx, 'g-1', REVOKED),
      'stageRemoveMembersByDevice',
    ],
  ] as const;

  afterEach(() => clearEpochGap('g-1'));

  it('stages a refresh as a plain commit transaction that admits and removes nobody', async () => {
    const ctx = branchCtx({ base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 } });
    await proto.refreshOwnLeaf.call(ctx, 'g-1');
    expect(ctx.runCommitTransaction).toHaveBeenCalledTimes(1);
    // No `removes`, no `excludeDeviceIds`: the server must queue it to nobody extra and record no
    // admission - a refresh is neither a departure nor an arrival.
    expect(ctx.runCommitTransaction.mock.calls[0][2]).toBeUndefined();
    expect(ctx.ownContextMatchesBase).toHaveBeenCalledWith(
      'g-1',
      new Uint8Array([0x66, 0x6f, 0x6f])
    );
    expect(ctx.stageSelfUpdate).toHaveBeenCalledExactlyOnceWith('g-1', INTENT);
  });

  it('stages the removal of a revoked device on the published branch, declaring what it removes', async () => {
    const ctx = branchCtx({ base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 } });
    await proto.removeMemberDevice.call(ctx, 'g-1', REVOKED);
    expect(ctx.ownContextMatchesBase).toHaveBeenCalledTimes(1);
    expect(ctx.stageRemoveMembersByDevice).toHaveBeenCalledExactlyOnceWith('g-1', REVOKED, INTENT);
    expect(ctx.runCommitTransaction.mock.calls[0][2]).toEqual({
      removes: [{ userId: 'user-b', deviceId: 'dev-lost' }],
    });
  });

  it('refuses a refresh on a follower tab BEFORE fetching the published base', async () => {
    const leadership = await import('$lib/mls-client/tabLeader');
    vi.spyOn(leadership, 'getTabLeadership').mockReturnValue('follower');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = branchCtx({ base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 } });
    await expect(proto.refreshOwnLeaf.call(ctx, 'g-1')).rejects.toBeInstanceOf(
      FollowerTabCommitError
    );
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
    expect(ctx.runCommitTransaction).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  describe.each(commits)('%s', (_name, commit, stageName) => {
    it.each([
      ['no base is published', { base: null }, 'no-base'],
      [
        'the base is of another epoch',
        { base: { groupInfo: GI, baseEpoch: 4, activeEpoch: 4 } },
        'other-epoch',
      ],
      [
        'this device is on another branch at the same epoch number',
        { base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 }, matches: false },
        'diverged',
      ],
    ] as const)('refuses, staging nothing, when %s', async (_n, opts, reason) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ctx = branchCtx(opts);
      const err = await commit(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnpublishedBranchError);
      expect((err as UnpublishedBranchError).reason).toBe(reason);
      expect(ctx[stageName]).not.toHaveBeenCalled();
      // ONLY a fork accuses: it is handed to rung 2 through the epoch-gap registry, said at error
      // level. A missing or older base says nothing about this device's branch.
      expect(isInEpochGap('g-1')).toBe(reason === 'diverged');
      expect(error).toHaveBeenCalledTimes(reason === 'diverged' ? 1 : 0);
      error.mockRestore();
    });
  });
});

/** Only `sendMessage` and what it reaches; the two dozen other abstract members stay unstubbed. */
abstract class SendHarness extends BaseMlsService {
  readonly scheduled: string[] = [];
  constructor() {
    super('web');
    (this as unknown as { delivery: unknown }).delivery = {
      postApplicationMessage: async () => null,
    };
    (this as unknown as { scheduleLeafRefresh: (g: string) => void }).scheduleLeafRefresh = (
      g: string
    ) => {
      this.scheduled.push(g);
    };
  }
  /** No staged commit is kept in this state: a send asks, and finds nothing to settle. */
  protected async groupsWithPendingCommit(): Promise<string[]> {
    return [];
  }
  protected async encryptForSend(): Promise<AuthoredFrame> {
    return { sealed: sealedFrame(1), authorProof: new Uint8Array([4]) };
  }
}
const Harness = SendHarness as unknown as new () => SendHarness;

describe('BaseMlsService.sendMessage - which sends ask whether a refresh is due', () => {
  const cases: Array<[string, FrameDelivery, boolean]> = [
    ['a visible message', DELIVERY.visible, true],
    ['a mutation (reaction, edit, read receipt)', DELIVERY.mutation, true],
    ['transport traffic, which every connection sends', DELIVERY.transport, false],
    ['a Graine seed - key-group traffic, never a refresh trigger', DELIVERY.keyMaterial, false],
    // A NEW object on every call, shaped exactly like a mutation: neither its identity nor its
    // value may make it look like a conversation send.
    ['a seed ADDRESSED to one requester', addressedKeyMaterial('user-b:dev-b'), false],
  ];
  it.each(cases)('%s', async (_name, delivery, asks) => {
    const svc = new Harness();
    await svc.sendMessage('g-1', new Uint8Array([9]), undefined, delivery);
    expect(svc.scheduled).toEqual(asks ? ['g-1'] : []);
  });
});
