// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { fromBase64 } from '$lib/utils/hex';
import { channelScope, type DistributionScope } from '$lib/mls-client/distributionScope';
import type { ExternalJoinOutcome } from '$lib/mls-client/IMlsService';

/**
 * THE PUBLISHED BASE IS A PAIR, AND THE TWO HALVES MUST COME FROM THE SAME TREE.
 *
 * A group's external-join base is a GroupInfo blob plus the epoch it belongs to. Three paths
 * publish one: the refresh after every commit, the create path of a Graine distribution group, and
 * the external join that carries the base its own commit produces. All three used to read the two
 * halves themselves, and only `externalJoin` read them where nothing else could move the epoch.
 *
 * The other two ran `exportGroupInfo()` - which awaits, an IPC round trip on Tauri - and then read
 * `getEpoch()`. A commit landing in that window makes the blob the tree at N and the number N+1,
 * and THAT PAIR CANNOT BE WALKED BACK: the stored base is strictly monotonic, so epoch N+1 is then
 * owned by a base that is actually N, the true N+1 base is refused for ever, and every stateless
 * device builds an external commit the gate must refuse. `externalJoin` says so itself - "a blob
 * exported at any other epoch than the one the server will record it under would strand the group
 * for good".
 *
 * So the table below drives ALL THREE over one policy: the pair is read atomically, and if the
 * epoch moves under the export nothing is published at all. Asserting only on the shared helper
 * would prove nothing about a fourth caller that exports for itself - which is how these three came
 * apart in the first place.
 */

const GROUP = 'gggggggg-1111-4111-8111-111111111111';
const SALON = channelScope('ws-1', 'chan-1');

/** Prototype methods invoked through `.call`, so the real implementations are under test. */
const proto = BaseMlsService.prototype as unknown as {
  refreshGroupInfo(groupId: string): Promise<{ stored: boolean; baseEpoch: number } | null>;
  exportBaseForPublication(groupId: string): Promise<{ base: string; baseEpoch: number }>;
  publishCurrentBase(groupId: string): Promise<{ stored: boolean; baseEpoch: number }>;
  groupInfoChannel(groupId: string): unknown;
  registerDistributionGroup(scope: DistributionScope, groupId: string): void;
  ensureDistributionGroup(
    scope: DistributionScope,
    ref: {
      groupId: string;
      groupInfo: string | null;
      baseEpoch: number | null;
      activeEpoch: number;
    }
  ): Promise<ExternalJoinOutcome>;
  externalJoin(groupId: string): Promise<ExternalJoinOutcome>;
};

/**
 * @param moveEpochDuringExport a commit landing while the export is in flight - which is exactly
 *   what the MLS lock prevents, and what a publisher reading the two halves separately would
 *   otherwise ship. `runUnderMlsLock` is a pass-through here, so this models the lock NOT held.
 */
function makeCtx(moveEpochDuringExport: boolean) {
  // The tree's epoch, as state. The blob carries the epoch it was exported at in its first byte,
  // which is what lets every row below compare the two halves of what was published.
  const tree = { epoch: 5 };
  return {
    tree,
    userId: 'u',
    deviceId: 'd',
    delivery: {
      fetchGroupInfo: vi
        .fn()
        .mockResolvedValue({ groupInfo: 'AA==', baseEpoch: 5, activeEpoch: 5 }),
      storeGroupInfo: vi.fn().mockResolvedValue({ stored: true }),
      submitCommit: vi.fn().mockResolvedValue({ accepted: true, newEpoch: 6 }),
    },
    distributionScopeByGroup: new Map<string, DistributionScope>(),
    knownDistributionGroups: new Set<string>(),
    unsettledDistributionGroups: new Set<string>(),
    distributionGroupInfo: {
      fetch: vi.fn().mockResolvedValue(null),
      publish: vi.fn().mockResolvedValue({ stored: true }),
    },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    getLocalGroups: vi.fn().mockReturnValue([]),
    createGroup: vi.fn().mockResolvedValue(undefined),
    joinByExternalCommit: vi.fn().mockImplementation(async () => {
      // The external commit is applied to the returned instance at once: the epoch moves here.
      tree.epoch += 1;
      return { groupId: GROUP, commit: new Uint8Array([9]) };
    }),
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    clearPendingCommit: vi.fn().mockResolvedValue(undefined),
    forgetGroup: vi.fn(),
    getEpoch: vi.fn(() => tree.epoch),
    exportGroupInfo: vi.fn(async () => {
      const exportedAt = tree.epoch;
      await Promise.resolve();
      if (moveEpochDuringExport) tree.epoch += 1;
      return new Uint8Array([exportedAt]);
    }),
    // The real implementations of every hop the publishers take.
    refreshGroupInfo: proto.refreshGroupInfo,
    exportBaseForPublication: proto.exportBaseForPublication,
    publishCurrentBase: proto.publishCurrentBase,
    groupInfoChannel: proto.groupInfoChannel,
    registerDistributionGroup: proto.registerDistributionGroup,
    // The create path's lost-race branch joins the winner's base instead; not this file's subject.
    externalJoin: vi.fn().mockResolvedValue({ joined: true }),
  };
}

type Ctx = ReturnType<typeof makeCtx>;

/** What reached the transport: the blob, and the epoch it was published under. */
interface Published {
  base: string;
  baseEpoch: number;
}

interface Publisher {
  name: string;
  /** Whatever the row needs before it can publish (a scope registration, a base to join from). */
  prepare?: (ctx: Ctx) => void;
  run: (ctx: Ctx) => Promise<unknown>;
  /** The pair this row's transport received, or null if it published nothing. */
  published: (ctx: Ctx) => Published | null;
}

const PUBLISHERS: Publisher[] = [
  {
    name: 'the refresh after a commit',
    run: (ctx) => proto.refreshGroupInfo.call(ctx, GROUP),
    published: (ctx) => {
      const call = ctx.delivery.storeGroupInfo.mock.calls[0];
      return call ? { base: call[1] as string, baseEpoch: call[2] as number } : null;
    },
  },
  {
    name: 'the create path of a distribution group',
    run: (ctx) =>
      proto.ensureDistributionGroup.call(ctx, SALON, {
        groupId: GROUP,
        groupInfo: null,
        baseEpoch: null,
        activeEpoch: 0,
      }),
    published: (ctx) => {
      const call = ctx.distributionGroupInfo.publish.mock.calls[0];
      return call ? { base: call[1] as string, baseEpoch: call[2] as number } : null;
    },
  },
  {
    name: 'the external join carrying the base its own commit creates',
    run: (ctx) => proto.externalJoin.call(ctx, GROUP),
    published: (ctx) => {
      const call = ctx.delivery.submitCommit.mock.calls[0];
      // The base travels as the 5th argument, for the epoch the commit creates: base epoch + 1.
      return call ? { base: call[4] as string, baseEpoch: (call[1] as number) + 1 } : null;
    },
  },
];

describe('the published base - one publisher, three paths', () => {
  describe.each(PUBLISHERS)('$name', ({ prepare, run, published }) => {
    it('publishes a blob and an epoch that come from the same tree', async () => {
      const ctx = makeCtx(false);
      prepare?.(ctx);

      await run(ctx);

      const got = published(ctx);
      expect(got).not.toBeNull();
      // The blob says which epoch it was exported at. It must be the one it was published under.
      expect(fromBase64(got!.base)[0]).toBe(got!.baseEpoch);
    });

    it('publishes NOTHING when the epoch moves under the export', async () => {
      const ctx = makeCtx(true);
      prepare?.(ctx);

      await run(ctx);

      // Not a degraded publication, and not a retry: a pair from two different trees is
      // unrecoverable once stored, so the only safe answer is to publish neither half.
      expect(published(ctx)).toBeNull();
    });
  });

  it('is driving three distinct paths, and not one of them three times', () => {
    // The self-check: three rows resolving to the same call would make every case above a statement
    // about one publisher, and the divergence this file exists for would be invisible.
    expect(PUBLISHERS).toHaveLength(3);
    expect(new Set(PUBLISHERS.map((p) => p.name)).size).toBe(3);
    expect(new Set(PUBLISHERS.map((p) => p.run.toString())).size).toBe(3);
  });

  it('the refresh reports the epoch it published, not the one the tree is at now', async () => {
    const ctx = makeCtx(false);

    const outcome = await proto.refreshGroupInfo.call(ctx, GROUP);
    // A later commit moves the tree on. The answer already given describes what was published.
    ctx.tree.epoch += 3;

    expect(outcome).toEqual({ stored: true, baseEpoch: 5 });
  });

  it('the refresh answers null rather than throwing into the commit path that fired it', async () => {
    const ctx = makeCtx(true);

    // It is fired with `void` after every accepted commit: a throw here would be an unhandled
    // rejection on the happy path of every send.
    await expect(proto.refreshGroupInfo.call(ctx, GROUP)).resolves.toBeNull();
  });
});
