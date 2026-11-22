/**
 * A 401/403 from a PIN route is the server's ANSWER about the session, never "server unreachable"
 * (1.7.3-alpha.6 row 3: a device removed from another device, then its PIN typed at the gate). Only a
 * transport failure may read as unreachable.
 */
import { describe, it, expect, vi } from 'vitest';
import { withoutAnyComments } from '$lib/styles/markupSources';
import { readSource } from '../../../test/sourceTree';
import { m } from '$lib/paraglide/messages';
import { SessionEndedByDeviceRevocationError, SessionExpiredError } from '$lib/stores/auth';
import { ServerUnreachableError } from '$lib/utils/fetchOrUnreachable';
import { LocalizedError } from '$lib/utils/localizedError';
import { isServerUnreachable } from '$lib/utils/fetchOrUnreachable';
import { loginErrorCode, noKeypadNoticeFor } from './loginErrors';
import { unlockWithPin, type PinUnlockDeps } from './pinUnlock';
import {
  PinSessionRefusedError,
  settlePinSessionRefusal,
  throwIfPinSessionRefused,
} from './pinSessionRefusal';

const answer = (status: number) => new Response('{}', { status });

describe('throwIfPinSessionRefused - a 401/403 is a typed answer, raised at the request', () => {
  it.each([401, 403])(
    'types a %i as the session being refused, naming route and status',
    (status) => {
      for (const route of ['pin-salt', 'pin-check']) {
        let thrown: unknown;
        try {
          throwIfPinSessionRefused(answer(status), route);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(PinSessionRefusedError);
        expect((thrown as PinSessionRefusedError).route).toBe(route);
        expect((thrown as PinSessionRefusedError).status).toBe(status);
        // Never the unreachable type, never the unreachable sentence.
        expect(isServerUnreachable(thrown)).toBe(false);
        expect((thrown as LocalizedError).message).not.toBe(m.auth_pin_salt_unreachable());
        expect((thrown as LocalizedError).message).not.toBe(m.auth_pin_check_unreachable());
      }
    }
  );

  it.each([200, 201, 409, 429, 500, 503])('lets a %i through to its own branch', (status) => {
    expect(() => throwIfPinSessionRefused(answer(status), 'pin-salt')).not.toThrow();
  });
});

describe('settlePinSessionRefusal - what a refused session becomes at the gate', () => {
  const revoked = new SessionEndedByDeviceRevocationError({ userId: 'u', deviceId: 'd' });
  const refusal = new PinSessionRefusedError('pin-salt', 401);
  const run = (askSession: () => Promise<unknown>, settleRevocation = async () => false) =>
    settlePinSessionRefusal(refusal, { askSession, settleRevocation, log: vi.fn() });

  it("a session ended by this device's removal: device_revoked, the gate's no-keypad state", async () => {
    const settleRevocation = vi.fn(async () => true);
    const outcome = await run(() => Promise.reject(revoked), settleRevocation);
    expect(settleRevocation).toHaveBeenCalledWith(revoked);
    expect(loginErrorCode(outcome)).toBe('device_revoked');
    expect(noKeypadNoticeFor(loginErrorCode(outcome))).toBe(m.auth_device_revoked_here());
  });

  it('a session ended for another reason (or another device): the verdict, so the login signs out', async () => {
    const expired = new SessionExpiredError();
    expect(await run(() => Promise.reject(expired))).toBe(expired);
    expect(await run(() => Promise.reject(revoked))).toBe(revoked); // settleRevocation answers false
  });

  it('a transport failure while asking is unreachable and nothing else', async () => {
    const down = new ServerUnreachableError(m.auth_pin_salt_unreachable(), new TypeError('x'));
    const outcome = await run(() => Promise.reject(down));
    expect(outcome).toBe(down);
    expect(isServerUnreachable(outcome)).toBe(true);
  });

  it('a session the server says is alive: unexpected, accused as `other`, never retried', async () => {
    const outcome = await run(() => Promise.resolve('token'));
    expect(loginErrorCode(outcome)).toBe('other');
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

describe('wiring - both login-path PIN requests classify the refusal where they throw', () => {
  const source = withoutAnyComments(readSource('src/lib/composables/session/sessionAuth.ts'));

  it('pin-salt and pin-check each call throwIfPinSessionRefused before their `!res.ok` branch', () => {
    expect(source).toContain("throwIfPinSessionRefused(res, 'pin-salt')");
    expect(source).toContain("throwIfPinSessionRefused(res, 'pin-check')");
  });

  it('the login settles the refusal through the held refresh, never through a bare redirect', () => {
    expect(source).toContain("refreshAnswerHeldByCaller('pin-route-refused')");
  });
});
