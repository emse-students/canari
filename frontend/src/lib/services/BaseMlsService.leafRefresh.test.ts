// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { DELIVERY, type FrameDelivery } from '$lib/mls-client/frameDelivery';
import { readLeafRefreshLedger } from '$lib/mls-client/leafRefresh';

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
  stage: () => Promise<{ commit: Uint8Array; groupInfo: Uint8Array }>,
  opts?: Record<string, unknown>
) => Promise<unknown>;
const runCommitTransaction = (
  BaseMlsService.prototype as unknown as { runCommitTransaction: RunCommit }
).runCommitTransaction;

function commitCtx(accepted: boolean) {
  return {
    userId: U,
    deviceId: D,
    delivery: {
      submitCommit: vi
        .fn()
        .mockResolvedValue(
          accepted ? { accepted: true } : { accepted: false, reason: 'concurrent_commit' }
        ),
    },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    freshEpoch: vi.fn().mockResolvedValue(5),
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    clearPendingCommit: vi.fn().mockResolvedValue(undefined),
    catchUpOnRefusedCommit: vi.fn().mockResolvedValue(undefined),
  };
}

const staged = async () => ({ commit: new Uint8Array([1]), groupInfo: new Uint8Array([2]) });

beforeEach(() => localStorage.clear());

describe('BaseMlsService - every accepted own commit dates the leaf', () => {
  it('records the epoch the accepted commit created', async () => {
    await runCommitTransaction.call(commitCtx(true), 'g-1', staged, {});
    expect(readLeafRefreshLedger(U, D)['g-1']).toMatchObject({ epoch: 6 });
  });

  it('records nothing for a refused commit - the leaf did not change', async () => {
    await expect(runCommitTransaction.call(commitCtx(false), 'g-1', staged, {})).rejects.toThrow();
    expect(readLeafRefreshLedger(U, D)['g-1']).toBeUndefined();
  });

  it('refreshOwnLeaf is a plain commit transaction that admits and removes nobody', async () => {
    const run = vi.fn().mockResolvedValue({});
    const stageSelfUpdate = vi.fn().mockResolvedValue({
      commit: new Uint8Array([1]),
      groupInfo: new Uint8Array([2]),
    });
    await (
      BaseMlsService.prototype as unknown as { refreshOwnLeaf(g: string): Promise<void> }
    ).refreshOwnLeaf.call({ runCommitTransaction: run, stageSelfUpdate }, 'g-1');

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe('g-1');
    // No `removes`, no `excludeDeviceIds`: the server must queue it to nobody extra and record no
    // admission - a refresh is neither a departure nor an arrival.
    expect(run.mock.calls[0][2]).toBeUndefined();
    await run.mock.calls[0][1]();
    expect(stageSelfUpdate).toHaveBeenCalledExactlyOnceWith('g-1');
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
  protected async encryptForSend(): Promise<Uint8Array> {
    return new Uint8Array([1]);
  }
}
const Harness = SendHarness as unknown as new () => SendHarness;

describe('BaseMlsService.sendMessage - which sends ask whether a refresh is due', () => {
  const cases: Array<[string, FrameDelivery, boolean]> = [
    ['a visible message', DELIVERY.visible, true],
    ['a mutation (reaction, edit, read receipt)', DELIVERY.mutation, true],
    ['transport traffic, which every connection sends', DELIVERY.transport, false],
    ['a Graine seed, whose key group rotates on any epoch move', DELIVERY.keyMaterial, false],
  ];
  it.each(cases)('%s', async (_name, delivery, asks) => {
    const svc = new Harness();
    await svc.sendMessage('g-1', new Uint8Array([9]), undefined, delivery);
    expect(svc.scheduled).toEqual(asks ? ['g-1'] : []);
  });
});
