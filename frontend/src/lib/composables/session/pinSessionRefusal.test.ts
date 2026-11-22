/**
 * A 401/403 from a PIN route is the server's ANSWER about the session, never "server unreachable"
 * (1.7.3-alpha.6 row 3: a device removed from another device, then its PIN typed at the gate). Only a
 * transport failure may read as unreachable - and that includes the failure of the question asked to
 * explain the refusal.
 */
import { describe, it, expect, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { withoutAnyComments } from '$lib/styles/markupSources';
import {
  SessionEndedByDeviceRevocationError,
  SessionExpiredError,
  TransientAnswerError,
} from '$lib/stores/auth';
import { ServerUnreachableError, isServerUnreachable } from '$lib/utils/fetchOrUnreachable';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { readSource } from '../../../test/sourceTree';
import { loginErrorCode, noKeypadNoticeFor } from './loginErrors';
import { unlockWithPin, type PinUnlockDeps } from './pinUnlock';
import {
  PinSessionRefusedError,
  settlePinSessionRefusal,
  settleRevocationOfThisDevice,
  throwIfPinSessionRefused,
  type PinSessionRefusalDeps,
} from './pinSessionRefusal';

const UNREACHABLE = m.auth_pin_salt_unreachable();

/** An answer as our own service writes it: Nest's envelope, which carries the status. */
const gateway = (status: number) =>
  Response.json({ statusCode: status, message: 'Unauthorized' }, { status });
/** An answer a WAF or a captive portal writes in the API's place. */
const edgeHtml = (status: number) =>
  new Response('<html>blocked</html>', { status, headers: { 'Content-Type': 'text/html' } });
const edgeJson = (status: number) =>
  Response.json({ type: 'block', title: 'Blocked', status }, { status });

async function thrown(call: () => Promise<void>): Promise<unknown> {
  try {
    await call();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('throwIfPinSessionRefused - our own 401/403 is a typed answer, raised at the request', () => {
  it.each([401, 403])(
    'types our own %i on both routes, naming route and status',
    async (status) => {
      for (const route of ['pin-salt', 'pin-check']) {
        const e = await thrown(() => throwIfPinSessionRefused(gateway(status), route, UNREACHABLE));
        expect(e).toBeInstanceOf(PinSessionRefusedError);
        expect((e as PinSessionRefusedError).route).toBe(route);
        expect((e as PinSessionRefusedError).status).toBe(status);
        expect(isServerUnreachable(e)).toBe(false);
      }
    }
  );

  it.each([
    ['an HTML 403 (WAF ban page, portal)', edgeHtml(403)],
    ['an HTML 401', edgeHtml(401)],
    ["a JSON block page that is not Nest's envelope", edgeJson(403)],
  ])(
    'reads %s as the network path failing: unreachable, not a session refusal',
    async (_n, res) => {
      const e = await thrown(() => throwIfPinSessionRefused(res, 'pin-salt', UNREACHABLE));
      expect(e).toBeInstanceOf(ServerUnreachableError);
      expect(isServerUnreachable(e)).toBe(true);
      expect((e as Error).message).toBe(UNREACHABLE);
      expect(loginErrorCode(e)).toBe('server_unreachable');
    }
  );

  it.each([200, 201, 409, 429, 500, 503])('lets a %i through to its own branch', async (status) => {
    expect(
      await thrown(() => throwIfPinSessionRefused(gateway(status), 'pin-salt', UNREACHABLE))
    ).toBe(undefined);
  });
});

describe('settlePinSessionRefusal - what a refused session becomes at the gate', () => {
  const revoked = new SessionEndedByDeviceRevocationError({ userId: 'u', deviceId: 'd' });
  const refusal = new PinSessionRefusedError('pin-salt', 401);
  const run = (over: Partial<PinSessionRefusalDeps> & Pick<PinSessionRefusalDeps, 'askSession'>) =>
    settlePinSessionRefusal(refusal, {
      settleRevocation: async () => false,
      stillListening: () => true,
      releaseVerdict: vi.fn(),
      unreachable: UNREACHABLE,
      log: vi.fn(),
      ...over,
    });

  it("a session ended by this device's removal: device_revoked, the gate's no-keypad state", async () => {
    const settleRevocation = vi.fn(async () => true);
    const outcome = await run({ askSession: () => Promise.reject(revoked), settleRevocation });
    expect(settleRevocation).toHaveBeenCalledWith(revoked);
    expect(loginErrorCode(outcome)).toBe('device_revoked');
    expect(noKeypadNoticeFor(loginErrorCode(outcome))).toBe(m.auth_device_revoked_here());
  });

  it('a session ended for another reason (or another device): the verdict, so the login signs out', async () => {
    const expired = new SessionExpiredError();
    expect(await run({ askSession: () => Promise.reject(expired) })).toBe(expired);
    expect(await run({ askSession: () => Promise.reject(revoked) })).toBe(revoked);
  });

  const transportRejections: [string, () => unknown][] = [
    ['a TransportFailureError', () => new TransportFailureError(new TypeError('Failed to fetch'))],
    [
      'a RequestDeadlineError',
      () => new RequestDeadlineError('write', 30_000, 'POST', '/refresh', 0),
    ],
    ['a TransientAnswerError (5xx)', () => new TransientAnswerError(503)],
    ['a TransientAnswerError (429)', () => new TransientAnswerError(429)],
    ['a TransientAnswerError (408)', () => new TransientAnswerError(408)],
  ];
  it.each(transportRejections)(
    'a renewal that ends as %s is unreachable, accused of nothing, its cause kept',
    async (_n, make) => {
      const cause = make();
      const settleRevocation = vi.fn(async () => true);
      const outcome = await run({ askSession: () => Promise.reject(cause), settleRevocation });
      expect(outcome).toBeInstanceOf(ServerUnreachableError);
      expect(isServerUnreachable(outcome)).toBe(true);
      expect(loginErrorCode(outcome)).toBe('server_unreachable');
      expect((outcome as Error).message).toBe(UNREACHABLE);
      expect((outcome as ServerUnreachableError).cause).toBe(cause);
      // Nothing was learned about the session: no reset is even considered.
      expect(settleRevocation).not.toHaveBeenCalled();
    }
  );

  it('a session the server says is alive: unexpected, accused as `other`, never retried', async () => {
    const outcome = await run({ askSession: () => Promise.resolve('token') });
    expect(loginErrorCode(outcome)).toBe('other');
  });

  it('releases the held verdict when nobody is listening any more, and only then', async () => {
    const releaseVerdict = vi.fn();
    await run({
      askSession: () => Promise.reject(revoked),
      stillListening: () => true,
      releaseVerdict,
    });
    expect(releaseVerdict).not.toHaveBeenCalled();
    await run({
      askSession: () => Promise.reject(revoked),
      stillListening: () => false,
      releaseVerdict,
    });
    expect(releaseVerdict).toHaveBeenCalledTimes(1);
    await run({
      askSession: () => Promise.resolve('t'),
      stillListening: () => false,
      releaseVerdict,
    });
    expect(releaseVerdict).toHaveBeenCalledTimes(2);
  });
});

describe('settleRevocationOfThisDevice - a reset needs the fact that names THIS device', () => {
  const named = (userId: string, deviceId: string) =>
    new SessionEndedByDeviceRevocationError({ userId, deviceId });
  const deps = (stored: string | null, over = {}) => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        userId: 'u',
        storedDeviceId: () => stored,
        stopIfSignedOut: () => void calls.push('stop'),
        startOwnWipe: () => void calls.push('start'),
        wipe: async () => {
          calls.push('wipe');
          return true;
        },
        ...over,
      },
    };
  };

  it('wipes, in order, when the refusal names this account and this stored device', async () => {
    const { calls, deps: d } = deps('d1');
    expect(await settleRevocationOfThisDevice(named('u', 'd1'), d)).toBe(true);
    expect(calls).toEqual(['stop', 'start', 'wipe']);
  });

  it.each([
    ['another device of the account', named('u', 'other'), 'd1'],
    ['an id this install rotated away from (stored id changed)', named('u', 'd1'), 'd2'],
    ['another account', named('v', 'd1'), 'd1'],
    ['an install holding no device id', named('u', 'd1'), null],
  ])('does NOT wipe for a revocation naming %s', async (_n, verdict, stored) => {
    const { calls, deps: d } = deps(stored as string | null);
    expect(await settleRevocationOfThisDevice(verdict, d)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('does not wipe for a dead session that is no revocation at all', async () => {
    const { calls, deps: d } = deps('d1');
    expect(await settleRevocationOfThisDevice(new SessionExpiredError(), d)).toBe(false);
    expect(await settleRevocationOfThisDevice(new Error('x'), d)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reports the wipe that did not run (the reset answers false)', async () => {
    const { deps: d } = deps('d1', { wipe: async () => false });
    expect(await settleRevocationOfThisDevice(named('u', 'd1'), d)).toBe(false);
  });
});

describe('through unlockWithPin - the typed refusal is neither swallowed nor retried', () => {
  const deps = (over: Partial<PinUnlockDeps>): PinUnlockDeps => ({
    intent: 'unlock',
    saltAhead: undefined,
    fetchSalt: async () => 'salt',
    computeVerifier: async () => 'v',
    deriveDeviceKey: async () => 'k',
    resolveDeviceId: async () => 'd',
    checkPin: async () => ({ status: 'ok' }),
    wipeRevokedDevice: async () => {},
    installDeviceKey: vi.fn(),
    log: () => {},
    ...over,
  });

  it('a 401 on the salt reaches the caller as the typed refusal, once, with no key installed', async () => {
    const fetchSalt = vi.fn(async () => {
      throw new PinSessionRefusedError('pin-salt', 401);
    });
    const d = deps({ fetchSalt });
    await expect(unlockWithPin(d)).rejects.toBeInstanceOf(PinSessionRefusedError);
    expect(fetchSalt).toHaveBeenCalledTimes(1);
    expect(d.installDeviceKey).not.toHaveBeenCalled();
  });

  it('a 401 on the check reaches the caller as the typed refusal, once, with no key installed', async () => {
    const checkPin = vi.fn(async () => {
      throw new PinSessionRefusedError('pin-check', 401);
    });
    const d = deps({ checkPin });
    await expect(unlockWithPin(d)).rejects.toBeInstanceOf(PinSessionRefusedError);
    expect(checkPin).toHaveBeenCalledTimes(1);
    expect(d.installDeviceKey).not.toHaveBeenCalled();
  });
});

describe('wiring - every PIN request of the login AND of the recovery classifies the refusal', () => {
  const source = withoutAnyComments(readSource('src/lib/composables/session/sessionAuth.ts'));
  const count = (needle: string) => source.split(needle).length - 1;

  it('pin-salt once, pin-check at the login and at the recovery', () => {
    expect(count("throwIfPinSessionRefused(res, 'pin-salt'")).toBe(1);
    expect(count("throwIfPinSessionRefused(res, 'pin-check'")).toBe(2);
    expect(source).toMatch(
      /throwIfPinSessionRefused\(\s*res,\s*'pin-check',\s*m\.auth_pin_verify_new_unreachable/
    );
  });

  it('both flows settle through the one answerPinSessionRefusal, and ask by the held refresh', () => {
    expect(count('answerPinSessionRefusal(')).toBeGreaterThanOrEqual(2);
    expect(count("refreshAnswerHeldByCaller('pin-route-refused')")).toBe(1);
  });
});
