// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';

/**
 * Unit-tests the external-join ORCHESTRATION (Phase 4a) in isolation: fetch GroupInfo -> build the
 * external commit -> submit under the epoch gate -> merge (accept) or forget + retry (reject).
 * The crypto round-trip itself is covered by the mls-core integration test; here we drive the
 * BaseMlsService method against stubbed primitives via `.call` to avoid a full concrete subclass.
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
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    refreshGroupInfo: vi.fn().mockResolvedValue(undefined),
    forgetGroup: vi.fn(),
    ...overrides,
  };
}

const externalJoin = (ctx: unknown, groupId: string): Promise<boolean> =>
  (BaseMlsService.prototype.externalJoin as (g: string) => Promise<boolean>).call(ctx, groupId);

describe('BaseMlsService.externalJoin', () => {
  it('returns false without joining when no GroupInfo is stored', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue(null);

    expect(await externalJoin(ctx, 'g')).toBe(false);
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

    // The welcome_request fallback lives on this `false`, so an outage must keep reaching it.
    expect(await externalJoin(ctx, 'g')).toBe(false);
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
  });

  // The claim `externalJoin`'s doc makes about its own blast radius, tested rather than asserted:
  // a distribution group is routed to its own transport by the REAL `groupInfoChannel` this harness
  // installs, so it never touches the membership-gated endpoint and cannot raise that refusal.
  it('routes a distribution group away from the membership-gated endpoint entirely', async () => {
    const ctx = makeCtx({
      distributionScopeByGroup: new Map([['g', 'community']]),
      distributionGroupInfo: {
        fetch: vi.fn().mockResolvedValue({ groupInfo: 'AA==', baseEpoch: 3 }),
        publish: vi.fn().mockResolvedValue({ stored: true }),
      },
    });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true });

    expect(await externalJoin(ctx, 'g')).toBe(true);
    expect(ctx.delivery.fetchGroupInfo).not.toHaveBeenCalled();
  });

  it('joins, submits against the base epoch, merges and succeeds on accept', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({ groupInfo: 'AA==', baseEpoch: 5 });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: true, newEpoch: 6 });

    expect(await externalJoin(ctx, 'g')).toBe(true);
    // Submitted with the GroupInfo's base epoch and excluding our own device from the fan-out.
    expect(ctx.delivery.submitCommit).toHaveBeenCalledWith('g', 5, expect.any(String), ['u:d']);
    expect(ctx.mergePendingCommit).toHaveBeenCalledWith('g');
    expect(ctx.forgetGroup).not.toHaveBeenCalled();
  });

  it('discards and retries with a fresher GroupInfo on an epoch-race reject, then succeeds', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo
      .mockResolvedValueOnce({ groupInfo: 'AA==', baseEpoch: 5 })
      .mockResolvedValueOnce({ groupInfo: 'AA==', baseEpoch: 6 });
    ctx.delivery.submitCommit
      .mockResolvedValueOnce({ accepted: false, reason: 'epoch_mismatch' })
      .mockResolvedValueOnce({ accepted: true, newEpoch: 7 });

    expect(await externalJoin(ctx, 'g')).toBe(true);
    // The rejected external commit cannot be cleared -> the group is discarded before the retry.
    expect(ctx.forgetGroup).toHaveBeenCalledWith('g');
    expect(ctx.delivery.fetchGroupInfo).toHaveBeenCalledTimes(2);
    expect(ctx.mergePendingCommit).toHaveBeenCalledTimes(1);
  });

  it('returns false when the external commit build fails (e.g. already local)', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({ groupInfo: 'AA==', baseEpoch: 5 });
    ctx.joinByExternalCommit.mockRejectedValue(new Error('already present locally'));

    expect(await externalJoin(ctx, 'g')).toBe(false);
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();
  });

  it('gives up (false) after exhausting retries on persistent epoch races', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchGroupInfo.mockResolvedValue({ groupInfo: 'AA==', baseEpoch: 5 });
    ctx.delivery.submitCommit.mockResolvedValue({ accepted: false, reason: 'epoch_mismatch' });

    expect(await externalJoin(ctx, 'g')).toBe(false);
    expect(ctx.forgetGroup).toHaveBeenCalledTimes(3);
  });
});
