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
      runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
      freshEpoch: vi.fn().mockResolvedValue(5),
      mergePendingCommit: vi.fn().mockResolvedValue(undefined),
      // No staged commit kept in the state: the commit here is answered at once.
      groupsWithPendingCommit: vi.fn(async () => []),
      // REAL: with no staged commit kept they settle nothing and submit once.
      ...Object.fromEntries(
        ['settleUnresolvedLocked', 'checkpointStageBeforeSend', 'submitRecorded'].map((name) => [
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
});
