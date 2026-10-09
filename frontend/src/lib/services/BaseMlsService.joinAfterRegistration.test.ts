// Same import-cycle break as `BaseMlsService.externalJoin.test.ts`.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import type { ExternalJoinOutcome } from '$lib/mls-client/IMlsService';

/**
 * A NEW DEVICE'S EXTERNAL JOIN MUST NOT REACH THE COMMIT GATE BEFORE ITS KEYPACKAGE DOES.
 *
 * Measured on production 2026-10-09, every one of the six `[MEMBERSHIP_ACTIVE] REFUSED ...
 * reason=no_key_package` lines of the previous 32 hours, on four community distribution groups and
 * never a conversation: the device's first run logged `[PURGE_PREKEYS]` (the start of its key
 * package round), then `[COMMIT] START` for the community group and the refusal, within the same
 * second, and only then `[REGISTER_DEVICE] START`. The commit gate answers an activation for a
 * device with no static KeyPackage with `no_key_package` and writes no membership row; the device
 * then holds the group's tree with no row the server routes anything to, which is the "this device
 * holds the distribution group but the group holds NO row for it" repair and its extra epoch.
 *
 * THE OVERLAP IS THE DEFECT. The community loader joins as soon as the page has the community, and
 * the key package round (mint, checkpoint, publish) runs beside it: the mint holds the MLS lock
 * only for its own span, so the join takes the lock the instant the mint lets go and commits one
 * checkpoint and one HTTP round trip before the publication. Ordering the two is the fix, and the
 * ordering is the existing in-flight round rather than a timer.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u',
    deviceId: 'd',
    delivery: {
      fetchGroupInfo: vi
        .fn()
        .mockResolvedValue({ groupInfo: 'AA==', baseEpoch: 5, activeEpoch: 5 }),
      submitCommit: vi.fn().mockResolvedValue({ accepted: true, newEpoch: 6 }),
      storeGroupInfo: vi.fn().mockResolvedValue(undefined),
    },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    groupInfoChannel: (
      BaseMlsService.prototype as unknown as { groupInfoChannel: (groupId: string) => unknown }
    ).groupInfoChannel,
    distributionScopeByGroup: new Map<string, string>(),
    knownDistributionGroups: new Set<string>(),
    distributionGroupInfo: null,
    joinByExternalCommit: vi.fn().mockResolvedValue({ groupId: 'g', commit: new Uint8Array([9]) }),
    getEpoch: vi.fn(() => 6),
    exportGroupInfo: vi.fn().mockResolvedValue(new Uint8Array([7, 7])),
    exportBaseForPublication: (
      BaseMlsService.prototype as unknown as {
        exportBaseForPublication: (groupId: string) => Promise<{ base: string; baseEpoch: number }>;
      }
    ).exportBaseForPublication,
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    refreshGroupInfo: vi.fn().mockResolvedValue(null),
    forgetGroup: vi.fn(),
    keyPackageRoundInFlight: null as Promise<unknown> | null,
    ...overrides,
  };
}

const externalJoin = (ctx: unknown, groupId: string): Promise<ExternalJoinOutcome> =>
  (
    BaseMlsService.prototype.externalJoin as unknown as (g: string) => Promise<ExternalJoinOutcome>
  ).call(ctx, groupId);

const generateKeyPackage = (ctx: unknown, deviceKey: string): Promise<unknown> =>
  (BaseMlsService.prototype.generateKeyPackage as unknown as (k: string) => Promise<unknown>).call(
    ctx,
    deviceKey
  );

/** Lets every already-resolved promise chain run, so "has not happened yet" is a real reading. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('a join waits for the key package round that is already running', () => {
  it('does not build or submit its commit until the round has published', async () => {
    let publish!: () => void;
    const round = new Promise<void>((resolve) => {
      publish = resolve;
    });
    const ctx = makeCtx({ keyPackageRoundInFlight: round });

    const joined = externalJoin(ctx, 'g');
    await settle();

    // THE ORDERING: a commit submitted here is the one the gate answers `no_key_package`.
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();

    publish();
    expect(await joined).toEqual({ joined: true });
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);
  });

  it('joins at once when no round is running', async () => {
    const ctx = makeCtx();
    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);
  });

  it('joins anyway, and says so, when the round FAILED - the join is no worse than it was', async () => {
    // A failed round already reported itself to its own caller (the device cap has a toast), and
    // the sync skips the welcome_request for it. Holding the join for ever behind a round that
    // cannot succeed would be a dead end with no exit; proceeding is the behaviour it had, and the
    // refusal it then earns is the visible end of the failed round, named in the log below.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const round = Promise.reject(new Error('register-device 502'));
    round.catch(() => {});
    const ctx = makeCtx({ keyPackageRoundInFlight: round });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('key package round FAILED'),
      expect.anything()
    );
    warn.mockRestore();
  });
});

describe('generateKeyPackage names the round it runs', () => {
  it('holds the round for exactly its own span, on success and on failure', async () => {
    let release!: () => void;
    const ctx = makeCtx({
      generateKeyPackageImpl: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ bytes: new Uint8Array(), notAfterSecs: 1 });
          })
      ),
    });

    const running = generateKeyPackage(ctx, 'k');
    expect(ctx.keyPackageRoundInFlight).toBeInstanceOf(Promise);
    release();
    await running;
    expect(ctx.keyPackageRoundInFlight).toBeNull();

    // A throw must not leave a round behind: every later join would wait on a settled failure.
    const failing = makeCtx({
      generateKeyPackageImpl: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(generateKeyPackage(failing, 'k')).rejects.toThrow('boom');
    expect(failing.keyPackageRoundInFlight).toBeNull();
  });
});
