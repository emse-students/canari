// Same import-cycle break as `BaseMlsService.externalJoin.test.ts`.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import type { ExternalJoinOutcome } from '$lib/mls-client/IMlsService';
import {
  DeliveryDeadlineError,
  DeviceRevokedError,
  KEY_PACKAGE_ROUND_DEADLINE_MS,
} from '$lib/mls-client/mlsDeliveryApi';

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
 * ordering is the SERVER'S OWN STATEMENT that the device holds a static KeyPackage, never a timer.
 *
 * THE RESIDUAL OF THAT FIX, closed here: waiting on "the round already running" saw no round for a
 * join that started BEFORE the round set its field, and held every join of a group behind a round
 * whose request never answered. The wait is now on the published fact (the read of what the gate
 * reads), and the round is only what makes it true.
 */
import { keyPackageWaitFields } from './BaseMlsService.keyPackageFixture';

const PUBLISHED = { kind: 'package', device: { keyPackage: new Uint8Array(), deviceId: 'd' } };
const ABSENT = { kind: 'none', reason: 'unregistered' };

type Server = { answer: unknown };

/**
 * A real `BaseMlsService` (prototype chain, no constructor) with only the fields the join needs, so
 * every private helper of the wait is the production one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCtx(overrides: Record<string, unknown> = {}): any {
  // What the server says about this device's KeyPackage: published by default (the ordinary join).
  const server: Server = { answer: PUBLISHED };
  return Object.assign(Object.create(BaseMlsService.prototype), {
    server,
    ...keyPackageWaitFields(),
    userId: 'u',
    deviceId: 'd',
    delivery: {
      fetchDeviceKeyPackage: vi.fn(async () => server.answer),
      fetchGroupInfo: vi
        .fn()
        .mockResolvedValue({ groupInfo: 'AA==', baseEpoch: 5, activeEpoch: 5 }),
      submitCommit: vi.fn().mockResolvedValue({ accepted: true, newEpoch: 6 }),
      storeGroupInfo: vi.fn().mockResolvedValue(undefined),
    },
    runUnderMlsLock: <T>(fn: () => Promise<T>) => fn(),
    distributionScopeByGroup: new Map<string, string>(),
    knownDistributionGroups: new Set<string>(),
    distributionGroupInfo: null,
    joinByExternalCommit: vi.fn().mockResolvedValue({ groupId: 'g', commit: new Uint8Array([9]) }),
    getEpoch: vi.fn(() => 6),
    exportGroupInfo: vi.fn().mockResolvedValue(new Uint8Array([7, 7])),
    mergePendingCommit: vi.fn().mockResolvedValue(undefined),
    refreshGroupInfo: vi.fn().mockResolvedValue(null),
    forgetGroup: vi.fn(),
    ...overrides,
  });
}

const externalJoin = (ctx: { externalJoin(g: string): Promise<ExternalJoinOutcome> }, g: string) =>
  ctx.externalJoin(g);

const KP = { bytes: new Uint8Array(), notAfterSecs: 1 };

/** Lets every already-resolved promise chain run, so "has not happened yet" is a real reading. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A round implementation that publishes (flips the server's answer) when released. */
function controlledRound(ctx: { server: Server }) {
  let release!: () => void;
  let fail!: (e: unknown) => void;
  const impl = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        release = () => {
          ctx.server.answer = PUBLISHED;
          resolve(KP);
        };
        fail = reject;
      })
  );
  return { impl, release: () => release(), fail: (e: unknown) => fail(e) };
}

describe('a join waits on the PUBLISHED FACT, not on a round', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not build or submit its commit until the round has published', async () => {
    const ctx = makeCtx();
    ctx.server.answer = ABSENT;
    const round = controlledRound(ctx);
    ctx.generateKeyPackageImpl = round.impl;

    const running = ctx.generateKeyPackage('k');
    const joined = externalJoin(ctx, 'g');
    await settle();

    // THE ORDERING: a commit submitted here is the one the gate answers `no_key_package`.
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();

    round.release();
    await running;
    expect(await joined).toEqual({ joined: true });
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);
  });

  it('joins at once when the server already holds the package', async () => {
    const ctx = makeCtx();
    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);
  });

  it('reads an ELAPSED package as published: the gate checks presence, not freshness', async () => {
    const ctx = makeCtx();
    ctx.server.answer = { kind: 'none', reason: 'expired' };
    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
  });

  it('LOST WAKE-UP: a round that settles while the fact is being read is not waited for', async () => {
    // The first read is in flight (it will answer ABSENT, true when it was asked) while a round
    // publishes and settles. Parking on that stale answer would wait for a round that already came
    // and went - for ever.
    const ctx = makeCtx();
    let answerStale!: () => void;
    ctx.delivery.fetchDeviceKeyPackage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerStale = () => resolve(ABSENT);
          })
      )
      .mockImplementation(async () => ctx.server.answer);
    ctx.generateKeyPackageImpl = vi.fn(async () => {
      ctx.server.answer = PUBLISHED;
      return KP;
    });

    const joined = externalJoin(ctx, 'g');
    await settle();
    await ctx.generateKeyPackage('k'); // publishes and settles during the read
    answerStale();

    expect(await joined).toEqual({ joined: true });
    expect(ctx.keyPackageRoundWaiters).toHaveLength(0);
  });

  it('WEDGE: absent with no round running STARTS the round instead of parking for ever', async () => {
    // A device row deleted server-side: no boot, republish or replenish is coming. The join starts
    // the only thing that can make the fact true.
    const ctx = makeCtx();
    ctx.server.answer = ABSENT;
    ctx.generateKeyPackageImpl = vi.fn(async () => {
      ctx.server.answer = PUBLISHED;
      return KP;
    });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    expect(ctx.generateKeyPackageImpl).toHaveBeenCalledTimes(1);
    expect(ctx.generateKeyPackageImpl).toHaveBeenCalledWith('device-key');
  });

  it('refuses typed when the round it started FAILED, and attempts no commit', async () => {
    const ctx = makeCtx();
    ctx.server.answer = ABSENT;
    ctx.generateKeyPackageImpl = vi.fn().mockRejectedValue(new Error('register-device 502'));

    expect(await externalJoin(ctx, 'g')).toEqual({
      joined: false,
      reason: 'key_package_round_failed',
    });
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
  });

  it('a round that succeeded but left the fact absent is unverified, never a second round', async () => {
    const ctx = makeCtx();
    ctx.server.answer = ABSENT;
    ctx.generateKeyPackageImpl = vi.fn(async () => KP);

    expect(await externalJoin(ctx, 'g')).toEqual({
      joined: false,
      reason: 'own_key_package_unverified',
    });
    expect(ctx.generateKeyPackageImpl).toHaveBeenCalledTimes(1);
  });

  it('does not attempt the join, with its OWN reason, when the fact cannot be read and no round runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = makeCtx();
    ctx.server.answer = { kind: 'unanswered', detail: 'HTTP 502' };
    ctx.generateKeyPackageImpl = vi.fn();

    expect(await externalJoin(ctx, 'g')).toEqual({
      joined: false,
      reason: 'own_key_package_unverified',
    });
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
    expect(ctx.generateKeyPackageImpl).not.toHaveBeenCalled();
    // The detail of the unanswered read reaches the log: it is the only evidence of why.
    expect(warn.mock.calls.flat().join(' ')).toContain('HTTP 502');
  });

  it('a failing round does not refuse a join while an OVERLAPPING round still runs', async () => {
    const ctx = makeCtx();
    ctx.server.answer = ABSENT;
    const older = controlledRound(ctx);
    const newer = controlledRound(ctx);
    ctx.generateKeyPackageImpl = vi
      .fn()
      .mockImplementationOnce(older.impl)
      .mockImplementationOnce(newer.impl);

    const a = ctx.generateKeyPackage('k');
    const b = ctx.generateKeyPackage('k');
    a.catch(() => {});
    b.catch(() => {});
    const joined = externalJoin(ctx, 'g');
    await settle();

    // The NEWER round fails; the older one is still alive and may publish.
    newer.fail(new Error('boom'));
    await settle();
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();

    older.release();
    expect(await joined).toEqual({ joined: true });
  });

  it('a join is not refused when the OLD round fails after the NEW one succeeded (re-enrolment)', async () => {
    const ctx = makeCtx();
    ctx.server.answer = ABSENT;
    const older = controlledRound(ctx);
    const newer = controlledRound(ctx);
    ctx.generateKeyPackageImpl = vi
      .fn()
      .mockImplementationOnce(older.impl)
      .mockImplementationOnce(newer.impl);

    const a = ctx.generateKeyPackage('k');
    const b = ctx.generateKeyPackage('k');
    a.catch(() => {});
    const joined = externalJoin(ctx, 'g');
    await settle();

    newer.release();
    await b;
    expect(await joined).toEqual({ joined: true });

    older.fail(new Error('late failure of the abandoned identity'));
    await a.catch(() => {});
    expect(ctx.keyPackageRoundsActive).toBe(0);
  });

  it('releases a parked join and the group flights when the client is torn down', async () => {
    const ctx = makeCtx({ destroyPlatformResources: vi.fn(), heldFrames: [] });
    ctx.server.answer = ABSENT;
    const round = controlledRound(ctx);
    ctx.generateKeyPackageImpl = round.impl;
    const running = ctx.generateKeyPackage('k');
    running.catch(() => {});

    const joined = externalJoin(ctx, 'g');
    await settle();
    expect(ctx.keyPackageRoundWaiters).toHaveLength(1);

    ctx.destroy();
    expect(await joined).toEqual({ joined: false, reason: 'own_key_package_unverified' });
    expect(ctx.keyPackageRoundWaiters).toHaveLength(0);
    round.release();
  });

  it('excludes the device id the round LEFT it with, not the one it started with', async () => {
    // The round's DeviceRevokedError path re-enrols the device under a new id mid-wait; the gate
    // must be told to skip the id that actually joined, or it fans the commit out to ourselves.
    const rotate = vi.fn(async function (this: { deviceId: string }) {
      this.deviceId = 'd-new';
      return 'd';
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = makeCtx({
      rotateDeviceIdentity: rotate,
      generateKeyPackageImpl: vi
        .fn()
        .mockImplementationOnce(async () => {
          await gate;
          throw new DeviceRevokedError('d');
        })
        .mockImplementation(async () => {
          ctx.server.answer = PUBLISHED;
          return KP;
        }),
    });
    ctx.server.answer = ABSENT;

    const round = ctx.generateKeyPackage('k');
    const joined = externalJoin(ctx, 'g');
    await settle();
    expect(ctx.delivery.submitCommit).not.toHaveBeenCalled();

    release();
    await round;
    expect(await joined).toEqual({ joined: true });
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(ctx.delivery.submitCommit.mock.calls[0][3]).toEqual(['u:d-new']);
  });

  it('shares ONE join between two callers of the same group', async () => {
    const ctx = makeCtx();
    ctx.server.answer = ABSENT;
    const round = controlledRound(ctx);
    ctx.generateKeyPackageImpl = round.impl;
    const running = ctx.generateKeyPackage('k');

    const first = externalJoin(ctx, 'g');
    const second = externalJoin(ctx, 'g');
    await settle();
    round.release();
    await running;

    expect(await first).toEqual({ joined: true });
    expect(await second).toEqual({ joined: true });
    expect(ctx.joinByExternalCommit).toHaveBeenCalledTimes(1);
    expect(ctx.delivery.submitCommit).toHaveBeenCalledTimes(1);

    // Nothing outlives the call: a later join of the same group is a new attempt.
    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    expect(ctx.joinByExternalCommit).toHaveBeenCalledTimes(2);
  });
});

describe('generateKeyPackage names the rounds it runs', () => {
  it('counts a round for exactly its own span, on success and on failure', async () => {
    const ctx = makeCtx();
    const round = controlledRound(ctx);
    ctx.generateKeyPackageImpl = round.impl;

    const running = ctx.generateKeyPackage('k');
    expect(ctx.keyPackageRoundInFlight).toBeInstanceOf(Promise);
    expect(ctx.keyPackageRoundsActive).toBe(1);
    round.release();
    await running;
    expect(ctx.keyPackageRoundInFlight).toBeNull();
    expect(ctx.keyPackageRoundsActive).toBe(0);
    expect(ctx.keyPackageRoundsSettled).toBe(1);

    // A throw must not leave a round behind: every later join would wait on a settled failure.
    const failing = makeCtx({
      generateKeyPackageImpl: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(failing.generateKeyPackage('k')).rejects.toThrow('boom');
    expect(failing.keyPackageRoundInFlight).toBeNull();
    expect(failing.keyPackageRoundsActive).toBe(0);
  });

  it('keeps counting the newer round when an older one settles first', async () => {
    const ctx = makeCtx();
    const older = controlledRound(ctx);
    const newer = controlledRound(ctx);
    ctx.generateKeyPackageImpl = vi
      .fn()
      .mockImplementationOnce(older.impl)
      .mockImplementationOnce(newer.impl);

    const a = ctx.generateKeyPackage('k');
    const b = ctx.generateKeyPackage('k');
    const newerPromise = ctx.keyPackageRoundInFlight;

    older.release();
    await a;
    expect(ctx.keyPackageRoundInFlight).toBe(newerPromise);
    expect(ctx.keyPackageRoundsActive).toBe(1);

    newer.release();
    await b;
    expect(ctx.keyPackageRoundInFlight).toBeNull();
    expect(ctx.keyPackageRoundsActive).toBe(0);
  });
});

describe('a round that HANGS, an empty biometric key, a bounded re-read, and the flights', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a never-resolving mint fails the round typed: the count returns to 0 and the join refuses', async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    ctx.server.answer = ABSENT;
    // A native `invoke` that never answers: it cannot be aborted, only abandoned.
    ctx.generateKeyPackageImpl = vi.fn(() => new Promise(() => {}));

    const running = ctx.generateKeyPackage('k').catch((e: unknown) => e);
    const joined = externalJoin(ctx, 'g');
    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_ROUND_DEADLINE_MS);

    expect(await running).toBeInstanceOf(DeliveryDeadlineError);
    expect(await joined).toEqual({ joined: false, reason: 'key_package_round_failed' });
    expect(ctx.keyPackageRoundsActive).toBe(0);
    expect(ctx.keyPackageRoundInFlight).toBeNull();
    expect(ctx.keyPackageRoundWaiters).toHaveLength(0);

    // The flight is released: a later join of the same group is a NEW attempt, not the hung promise.
    ctx.generateKeyPackageImpl = vi.fn(async () => {
      ctx.server.answer = PUBLISHED;
      return KP;
    });
    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
  });

  it('a join that STARTED the hung round is released too', async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    ctx.server.answer = ABSENT;
    ctx.generateKeyPackageImpl = vi.fn(() => new Promise(() => {}));

    const joined = externalJoin(ctx, 'g');
    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_ROUND_DEADLINE_MS);
    expect(await joined).toEqual({ joined: false, reason: 'key_package_round_failed' });
    expect(ctx.keyPackageRoundsActive).toBe(0);
  });

  it('starts the round with the key boot passed, EMPTY in biometric mode (the native layer resolves it)', async () => {
    const ctx = makeCtx({ currentDeviceKeyB64: '' });
    ctx.server.answer = ABSENT;
    ctx.generateKeyPackageImpl = vi.fn(async () => {
      ctx.server.answer = PUBLISHED;
      return KP;
    });

    expect(await externalJoin(ctx, 'g')).toEqual({ joined: true });
    expect(ctx.generateKeyPackageImpl).toHaveBeenCalledWith('');
  });

  it('ends the re-read loop on a PASS COUNT when rounds keep settling and the fact stays absent', async () => {
    const ctx = makeCtx();
    ctx.delivery.fetchDeviceKeyPackage.mockImplementation(async () => {
      ctx.keyPackageRoundsSettled++; // a round settles during every read, publishing nothing
      return ABSENT;
    });

    expect(await externalJoin(ctx, 'g')).toEqual({
      joined: false,
      reason: 'own_key_package_unverified',
    });
    expect(ctx.delivery.fetchDeviceKeyPackage).toHaveBeenCalledTimes(6);
    expect(ctx.joinByExternalCommit).not.toHaveBeenCalled();
  });

  it('warns ONCE per distinct reason and says what would change it; repeats are debug', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const ctx = makeCtx();
    ctx.server.answer = { kind: 'unanswered', detail: 'HTTP 502' };

    await externalJoin(ctx, 'g');
    await externalJoin(ctx, 'g');
    await externalJoin(ctx, 'g');

    const notAttempted = warn.mock.calls.flat().filter((m) => String(m).includes('not attempted'));
    expect(notAttempted).toHaveLength(1);
    expect(String(notAttempted[0])).toContain('what changes it');
    expect(
      debug.mock.calls.flat().filter((m) => String(m).includes('still not attempted'))
    ).toHaveLength(2);

    // A published fact clears it: the next failure is news again.
    ctx.server.answer = PUBLISHED;
    await externalJoin(ctx, 'g');
    ctx.server.answer = { kind: 'unanswered', detail: 'HTTP 502' };
    await externalJoin(ctx, 'g');
    expect(warn.mock.calls.flat().filter((m) => String(m).includes('not attempted:'))).toHaveLength(
      2
    );
  });

  it("a torn-down attempt's cleanup does not delete the flight of the join that replaced it", async () => {
    const ctx = makeCtx({ destroyPlatformResources: vi.fn(), heldFrames: [] });
    ctx.server.answer = ABSENT;
    const round = controlledRound(ctx);
    ctx.generateKeyPackageImpl = round.impl;
    ctx.generateKeyPackage('k').catch(() => {});

    const a = externalJoin(ctx, 'g');
    await settle();
    ctx.destroy();
    const b = externalJoin(ctx, 'g'); // owns the map entry now; `a`'s cleanup has not run yet
    await a;
    await settle();
    const c = externalJoin(ctx, 'g'); // must SHARE b, not start a third join

    round.release();
    expect(await b).toEqual({ joined: true });
    expect(await c).toEqual({ joined: true });
    expect(ctx.joinByExternalCommit).toHaveBeenCalledTimes(1);
  });
});
