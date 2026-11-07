// @vitest-environment happy-dom
// Same import-cycle break as `BaseMlsService.externalJoin.test.ts`.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));
vi.mock('$lib/mls-client/tabLeader', () => ({ getIsTabLeader: () => true }));

import { BaseMlsService } from './BaseMlsService';
import { KEY_PACKAGE_ROUND_DEADLINE_MS } from '$lib/mls-client/mlsDeliveryApi';
import { syncConnectionAfterWsOpen } from '$lib/mls-client/initializeConnection';
import { keyPackageWaitFields } from './BaseMlsService.keyPackageFixture';
import { flushMacrotask } from '../../test/flush';

/**
 * THE KEY PACKAGE SINGLE FLIGHT, IN ORDER. One round at a time: a plain caller joins the round in
 * flight, a `fresh` caller queues behind it. Two properties the first version missed (adversarial
 * review of #3134):
 *
 * - A fresh round's deadline bounds ITS OWN work. Counted from the call, it included the wait behind
 *   its predecessor: the fresh round was abandoned seconds into its own work, kept minting
 *   untracked, and the next plain caller found the slot empty and started a third round beside it.
 * - A reconnect's connection sync must not inherit the failure of the login round dying on the link
 *   that died: it asks for a fresh round, which runs after that one on the link its socket proved.
 *
 * Every assertion is on the ORDER of the rounds, never on a clock reading.
 */

type Ctx = {
  generateKeyPackage(k: string, opts?: { fresh?: boolean }): Promise<unknown>;
  generateKeyPackageImpl: ReturnType<typeof vi.fn>;
  keyPackageRoundInFlight: Promise<unknown> | null;
  keyPackageRoundsActive: number;
};

/** A real `BaseMlsService` (prototype chain, no constructor) with only what a round touches. */
function makeCtx(): Ctx {
  return Object.assign(Object.create(BaseMlsService.prototype), {
    ...keyPackageWaitFields(),
    userId: 'u',
    deviceId: 'd',
    generateKeyPackageImpl: vi.fn(),
  });
}

const kp = (name: string) => ({ bytes: new Uint8Array(), notAfterSecs: 1, name });

describe('a FRESH key package round gets its whole deadline for its own work', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts its deadline when its predecessor settles, and no third round starts while it runs', async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const order: string[] = [];
    // Each round needs almost the whole deadline: counted from the call, the fresh one would be
    // abandoned long before its own work ends.
    const nearlyTheDeadline = KEY_PACKAGE_ROUND_DEADLINE_MS - 1_000;
    const roundTaking = (name: string) => () => {
      order.push(`${name}:start`);
      return new Promise((resolve) =>
        setTimeout(() => {
          order.push(`${name}:end`);
          resolve(kp(name));
        }, nearlyTheDeadline)
      );
    };
    ctx.generateKeyPackageImpl
      .mockImplementationOnce(roundTaking('A'))
      .mockImplementationOnce(roundTaking('B'))
      .mockImplementation(roundTaking('C'));

    const a = ctx.generateKeyPackage('k');
    await vi.advanceTimersByTimeAsync(1_000);
    const b = ctx.generateKeyPackage('k', { fresh: true });
    const bSlot = ctx.keyPackageRoundInFlight;
    expect(order).toEqual(['A:start']);

    // A settles just inside its own deadline; B starts only now.
    await vi.advanceTimersByTimeAsync(nearlyTheDeadline - 1_000);
    expect(await a).toEqual(kp('A'));
    expect(order).toEqual(['A:start', 'A:end', 'B:start']);

    // Past the point a deadline counted from B's CALL would have abandoned it: B still holds the
    // slot, and a plain caller arriving now joins B rather than starting a round beside it.
    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_ROUND_DEADLINE_MS / 2);
    expect(ctx.keyPackageRoundInFlight).toBe(bSlot);
    const c = ctx.generateKeyPackage('k');

    await vi.advanceTimersByTimeAsync(KEY_PACKAGE_ROUND_DEADLINE_MS / 2);
    expect(await b).toEqual(kp('B'));
    expect(await c).toEqual(kp('B'));
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
    expect(ctx.generateKeyPackageImpl).toHaveBeenCalledTimes(2);
    expect(ctx.keyPackageRoundInFlight).toBeNull();
    expect(ctx.keyPackageRoundsActive).toBe(0);
  });
});

describe('a reconnect after a FAILED login round runs its own round', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('publishes on its own round instead of inheriting the login round failure', async () => {
    const ctx = makeCtx();
    const order: string[] = [];
    let failLogin!: (e: unknown) => void;
    ctx.generateKeyPackageImpl
      .mockImplementationOnce(() => {
        order.push('login:start');
        return new Promise((_resolve, reject) => (failLogin = reject));
      })
      .mockImplementationOnce(async () => {
        order.push('reconnect:start');
        return kp('reconnect');
      });

    // The login's round is in flight on a link that is about to die.
    const login = ctx.generateKeyPackage('k');
    login.catch(() => {});

    // The socket reopens: the reconnect's connection sync runs against the REAL single flight.
    const log = vi.fn();
    const synced = syncConnectionAfterWsOpen({
      mlsService: {
        generateKeyPackage: (k: string, opts?: { fresh?: boolean }) =>
          ctx.generateKeyPackage(k, opts),
        reconcilePublishedKeyPackages: vi.fn().mockResolvedValue(undefined),
        getUserGroups: vi.fn().mockResolvedValue([]),
        getLocalGroups: vi.fn().mockReturnValue([]),
        isDistributionGroup: vi.fn().mockReturnValue(false),
        registerDistributionGroup: vi.fn(),
        forgetGroup: vi.fn(),
        forgetDistributionGroupById: vi.fn().mockResolvedValue(true),
        getDeviceId: vi.fn().mockReturnValue('d'),
        waitForMessageQueueIdle: vi.fn().mockResolvedValue(undefined),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      userId: 'u',
      deviceKeyB64: 'k',
      processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
      onGroupMissing: vi.fn().mockResolvedValue(undefined),
      onStrandedSeat: vi.fn().mockResolvedValue(undefined),
      log,
    });
    await flushMacrotask();
    // Queued behind the login round, never beside it.
    expect(order).toEqual(['login:start']);

    failLogin(new Error('network down'));
    await expect(login).rejects.toThrow('network down');
    await synced;

    expect(order).toEqual(['login:start', 'reconnect:start']);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('KeyPackage published.');
    expect(lines.some((l) => l.includes('deferred to next connection'))).toBe(false);
  });
});
