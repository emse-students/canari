// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { recordingStage } from '../../test/recordingStage';
import { plainCommitLock } from '$lib/mls-client/test/fixtures/plainCommitLock';
import { workspaceScope } from '$lib/mls-client/distributionScope';

/**
 * A STAGED REMOVE DECLARES WHOM IT REMOVES (third review of #1878). The server's half of a removal
 * runs first and deletes the removed devices' rows, which the commit fan-out resolves from - so the
 * commit names its people, and the server queues it to the devices it parted for exactly them.
 * Without the declaration the removed devices never received the commit that removes them.
 */
describe('BaseMlsService - a staged Remove declares whom it removes', () => {
  const proto = BaseMlsService.prototype as unknown as {
    removeMember(g: string, u: string[]): Promise<void>;
    removeMemberDevice(g: string, d: string[]): Promise<void>;
  };

  it('removeMember names each person', async () => {
    const runCommitTransaction = vi.fn().mockResolvedValue({});

    await proto.removeMember.call({ runCommitTransaction }, 'g-1', ['user-b']);

    expect(runCommitTransaction.mock.calls[0][2]).toEqual({ removes: [{ userId: 'user-b' }] });
  });

  it('the commit transaction submits the declaration with the commit', async () => {
    const submitCommit = vi.fn().mockResolvedValue({ accepted: true, newEpoch: 6 });
    const recorder = recordingStage(() => 5);
    const ctx = {
      pendingSubmission: recorder.pendingSubmission,
      userId: 'user-a',
      deviceId: 'web-a',
      delivery: { submitCommit },
      ...plainCommitLock,
      runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
      freshEpoch: vi.fn().mockResolvedValue(5),
      // The key the merged commit gives this device's leaf, which the ledger names it by.
      ownLeafKey: vi.fn(async () => 'k-leaf'),
      mergePendingCommit: vi.fn().mockResolvedValue(undefined),
      // No staged commit kept in the state: the commit here is answered at once.
      groupsWithPendingCommit: vi.fn(async () => []),
      // REAL: with no staged commit kept they settle nothing and submit once.
      ...Object.fromEntries(
        [
          'settleUnresolvedLocked',
          'checkpointStageBeforeSend',
          'submitRecorded',
          'mergeAccepted',
          'noteOwnLeafReplaced',
        ].map((name) => [
          name,
          (BaseMlsService.prototype as unknown as Record<string, unknown>)[name],
        ])
      ),
    };
    const run = (
      BaseMlsService.prototype as unknown as {
        runCommitTransaction(
          g: string,
          stage: (intent: Uint8Array) => Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>,
          opts: unknown
        ): Promise<unknown>;
      }
    ).runCommitTransaction;

    await run.call(
      ctx,
      'g-1',
      recorder.wrap(async () => ({ commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) })),
      { removes: [{ userId: 'user-b' }] }
    );

    // The 7th argument: groupId, baseEpoch, proto, excludes, groupInfo, admits, removes.
    expect(submitCommit.mock.calls[0][6]).toEqual([{ userId: 'user-b' }]);
  });

  it('removeMemberDevice names the one device', async () => {
    const runCommitTransaction = vi.fn().mockResolvedValue({});

    // The published-branch check is `BaseMlsService.leafRefresh.test.ts`'s; here it vouches.
    const assertOnPublishedBranch = vi.fn(async () => async () => {});
    await proto.removeMemberDevice.call({ runCommitTransaction, assertOnPublishedBranch }, 'g-1', [
      'user-c:web-c1',
    ]);

    expect(runCommitTransaction.mock.calls[0][2]).toEqual({
      removes: [{ userId: 'user-c', deviceId: 'web-c1' }],
    });
  });

  it('removeDepartedMembers names each person, and asks the published branch before staging', async () => {
    const order: string[] = [];
    const runCommitTransaction = vi.fn(
      async (_g: string, stage: (intent: Uint8Array) => Promise<unknown>, _opts: unknown) => {
        order.push('transaction');
        await stage(new Uint8Array());
        return {};
      }
    );
    const assertOnPublishedBranch = vi.fn(async (_g: string, what: string) => {
      order.push(`base:${what}`);
      return async () => {
        order.push('vouched');
      };
    });
    const stageRemoveMembers = vi.fn(async () => {
      order.push('staged');
      return {};
    });

    await (
      BaseMlsService.prototype as unknown as {
        removeDepartedMembers(g: string, u: string[]): Promise<void>;
      }
    ).removeDepartedMembers.call(
      {
        runCommitTransaction,
        assertOnPublishedBranch,
        stageRemoveMembers,
        isDistributionGroup: () => false,
      },
      'g-1',
      ['user-b']
    );

    expect(runCommitTransaction.mock.calls[0][2]).toEqual({ removes: [{ userId: 'user-b' }] });
    // The check runs INSIDE the stage, against the state the commit is built from.
    expect(order).toEqual(['base:departed-member removal', 'transaction', 'vouched', 'staged']);
  });
});

/**
 * THE BASE IS READ WHERE THE GROUP KEEPS IT. A key group's base lives on social-service, and
 * chat-delivery's route answers 403 for it by construction - read there, every key-group departure
 * failed before comparing anything. These run the REAL check and the REAL routing: only the two
 * transports, the epoch and the context comparison are stubbed.
 */
describe('BaseMlsService - the departed-member removal reads the base through the group transport', () => {
  const GI = 'Zm9v';
  const scope = workspaceScope('ws-1');
  const real = BaseMlsService.prototype as unknown as Record<string, unknown>;
  const remove = (ctx: object, g: string) =>
    (real.removeDepartedMembers as (this: object, g: string, u: string[]) => Promise<void>).call(
      ctx,
      g,
      ['user-b']
    );

  function ctxFor(opts: {
    keyGroup: boolean;
    base: { groupInfo: string; baseEpoch: number; activeEpoch: number } | null;
  }) {
    const runCommitTransaction = vi.fn(
      async (_g: string, stage: (intent: Uint8Array) => Promise<unknown>, _opts: unknown) => {
        await stage(new Uint8Array());
        return {};
      }
    );
    const transport = { fetch: vi.fn().mockResolvedValue(opts.base), publish: vi.fn() };
    const delivery = {
      fetchGroupInfo: opts.keyGroup
        ? vi.fn().mockRejectedValue(new Error('403 from chat-delivery'))
        : vi.fn().mockResolvedValue(opts.base),
    };
    return {
      runCommitTransaction,
      transport,
      delivery,
      distributionGroupInfo: transport,
      distributionScopeByGroup: new Map(opts.keyGroup ? [['kg-1', scope]] : []),
      knownDistributionGroups: new Set(opts.keyGroup ? ['kg-1'] : []),
      freshEpoch: vi.fn().mockResolvedValue(5),
      ownContextMatchesBase: vi.fn().mockResolvedValue(true),
      stageRemoveMembers: vi.fn().mockResolvedValue({}),
      isDistributionGroup: real.isDistributionGroup,
      groupInfoChannel: real.groupInfoChannel,
      assertOnPublishedBranch: real.assertOnPublishedBranch,
    };
  }

  it('reads a key group base from its scope transport, never from chat-delivery', async () => {
    const ctx = ctxFor({ keyGroup: true, base: { groupInfo: GI, baseEpoch: 5, activeEpoch: 5 } });

    await remove(ctx, 'kg-1');

    expect(ctx.transport.fetch.mock.calls[0][0]).toEqual(scope);
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
    expect(ctx.stageRemoveMembers).toHaveBeenCalledOnce();
  });

  it('refuses a key group whose scope publishes no base, staging nothing', async () => {
    const ctx = ctxFor({ keyGroup: true, base: null });

    await expect(remove(ctx, 'kg-1')).rejects.toMatchObject({
      name: 'UnpublishedBranchError',
      reason: 'no-base',
    });
    expect(ctx.runCommitTransaction).not.toHaveBeenCalled();
  });

  it('stages a conversation departure when no base was ever published for it', async () => {
    const ctx = ctxFor({ keyGroup: false, base: null });

    await remove(ctx, 'conv-1');

    // Refusing here would keep the departed member's leaves forever: nothing publishes a base for
    // a conversation on a sweep's behalf.
    expect(ctx.delivery.fetchGroupInfo).toHaveBeenCalledWith('conv-1', undefined);
    expect(ctx.stageRemoveMembers).toHaveBeenCalledOnce();
    expect(ctx.ownContextMatchesBase).not.toHaveBeenCalled();
  });
});

/**
 * A MEMBER WHO STAYS, WITH ONE REVOKED DEVICE, ON A KEY GROUP - through the real service: the
 * revocation question goes to the delivery service, the removal reads its base through the scope
 * transport (never chat-delivery, which refuses a key group), and only the revoked device's leaf is
 * removed - the member's other device stays.
 */
describe('BaseMlsService - a revoked device of a member who stays, on a key group', () => {
  it('removes exactly the revoked leaf, vouched for by the scope base', async () => {
    const real = BaseMlsService.prototype as unknown as Record<string, unknown>;
    const scope = workspaceScope('ws-1');
    const transport = {
      fetch: vi.fn().mockResolvedValue({ groupInfo: 'Zm9v', baseEpoch: 5, activeEpoch: 5 }),
      publish: vi.fn(),
    };
    const ctx = {
      delivery: {
        fetchRevokedLeaves: vi.fn().mockResolvedValue(['bob:lost-phone']),
        fetchGroupInfo: vi.fn().mockRejectedValue(new Error('403 from chat-delivery')),
      },
      distributionGroupInfo: transport,
      distributionScopeByGroup: new Map([['kg-1', scope]]),
      knownDistributionGroups: new Set(['kg-1']),
      freshEpoch: vi.fn().mockResolvedValue(5),
      ownContextMatchesBase: vi.fn().mockResolvedValue(true),
      stageRemoveMembersByDevice: vi.fn().mockResolvedValue({}),
      runCommitTransaction: vi.fn(
        async (_g: string, stage: (intent: Uint8Array) => Promise<unknown>, _opts: unknown) => {
          await stage(new Uint8Array());
          return {};
        }
      ),
      groupInfoChannel: real.groupInfoChannel,
      assertOnPublishedBranch: real.assertOnPublishedBranch,
    };
    const call = <T>(name: string, ...args: unknown[]) =>
      (real[name] as (...a: unknown[]) => Promise<T>).call(ctx, ...args);

    const revoked = await call<string[]>('getRevokedLeaves', 'kg-1', [
      'bob:web-1',
      'bob:lost-phone',
    ]);
    await call('removeMemberDevice', 'kg-1', revoked);

    expect(ctx.delivery.fetchRevokedLeaves).toHaveBeenCalledWith('kg-1', [
      'bob:web-1',
      'bob:lost-phone',
    ]);
    expect(transport.fetch.mock.calls[0][0]).toEqual(scope);
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
    expect(ctx.stageRemoveMembersByDevice).toHaveBeenCalledWith(
      'kg-1',
      ['bob:lost-phone'],
      expect.anything()
    );
    expect(ctx.runCommitTransaction.mock.calls[0][2]).toEqual({
      removes: [{ userId: 'bob', deviceId: 'lost-phone' }],
    });
  });
});
