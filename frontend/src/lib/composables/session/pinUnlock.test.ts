import { LoginFailure } from './loginErrors';
import { unlockWithPin, type PinCheckAnswer, type PinUnlockDeps } from './pinUnlock';
import type { PinSaltAhead } from './pinSaltAhead';

/**
 * The PIN half of a login, driven through its decisions rather than read off its source.
 *
 * THE SECURITY CLAIM IS A BEHAVIOUR: the at-rest device key is installed for a PIN the server
 * ACCEPTED and for nothing else. So every refusal below is asserted by watching `installDeviceKey`
 * stay uncalled - which a regex over `loginImpl` could only infer from the order of some lines.
 */

/** Every call either side made, in order - several assertions are about the sequence. */
let order: string[];

function deps(answers: PinCheckAnswer[], overrides: Partial<PinUnlockDeps> = {}) {
  const queue = [...answers];
  const d = {
    saltAhead: undefined as Promise<PinSaltAhead> | undefined,
    fetchSalt: vi.fn(async () => {
      order.push('fetch-salt');
      return 'salt-fresh';
    }),
    computeVerifier: vi.fn(async (salt: string) => {
      order.push(`verifier:${salt}`);
      return `v(${salt})`;
    }),
    deriveDeviceKey: vi.fn(async (salt: string) => {
      order.push(`derive:${salt}`);
      return `key(${salt})`;
    }),
    resolveDeviceId: vi.fn(async () => 'dev-1'),
    checkPin: vi.fn(async (args: { verifier: string; deviceId: string; salt: string }) => {
      order.push(`check:${args.salt}`);
      const next = queue.shift();
      if (!next) throw new Error('no answer scripted');
      return next;
    }),
    wipeRevokedDevice: vi.fn(async () => {
      order.push('wipe');
    }),
    installDeviceKey: vi.fn((key: string) => {
      order.push(`install:${key}`);
    }),
    log: vi.fn(),
    ...overrides,
  };
  return d;
}

const failureCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof LoginFailure ? e.code : `untyped:${String(e)}`;
  }
  return 'resolved';
};

describe('unlockWithPin', () => {
  beforeEach(() => {
    order = [];
  });

  it('never installs the device key for a PIN the server refused', async () => {
    const d = deps([{ status: 'mismatch' }]);

    expect(await failureCode(unlockWithPin(d))).toBe('pin_mismatch');
    expect(d.installDeviceKey).not.toHaveBeenCalled();
    expect(d.wipeRevokedDevice).not.toHaveBeenCalled();
  });

  it('never installs the device key for an answer that is not ok or registered', async () => {
    // A 200 with an empty body, and a status this client does not know: neither said "accepted".
    for (const answer of [{}, { status: 'accepted-later' }]) {
      order = [];
      const d = deps([answer as unknown as PinCheckAnswer]);

      expect(await failureCode(unlockWithPin(d))).toBe('other');
      expect(d.installDeviceKey).not.toHaveBeenCalled();
      expect(d.wipeRevokedDevice).not.toHaveBeenCalled();
    }
  });

  it('wipes a revoked device and never installs its key, even with the right PIN', async () => {
    const d = deps([{ status: 'ok', resetRequired: true }]);

    expect(await failureCode(unlockWithPin(d))).toBe('device_revoked');
    expect(d.wipeRevokedDevice).toHaveBeenCalledTimes(1);
    expect(d.installDeviceKey).not.toHaveBeenCalled();
  });

  it('installs the key once the server accepted, derived after the verifier', async () => {
    const d = deps([{ status: 'ok' }]);

    expect(await unlockWithPin(d)).toBe('key(salt-fresh)');
    expect(d.installDeviceKey).toHaveBeenCalledTimes(1);
    // The derivation starts after the verifier (they would share the WebCrypto worker) and the
    // install comes after the server's answer.
    expect(order).toEqual([
      'fetch-salt',
      'verifier:salt-fresh',
      'derive:salt-fresh',
      'check:salt-fresh',
      'install:key(salt-fresh)',
    ]);
  });

  it('uses the salt asked ahead, and tells the server which salt it derived from', async () => {
    const d = deps([{ status: 'ok' }], { saltAhead: Promise.resolve({ salt: 'salt-ahead' }) });

    await unlockWithPin(d);

    expect(d.fetchSalt).not.toHaveBeenCalled();
    expect(d.checkPin).toHaveBeenCalledWith({
      verifier: 'v(salt-ahead)',
      deviceId: 'dev-1',
      salt: 'salt-ahead',
    });
  });

  it('turns a salt made stale by a PIN reset into a second check, never a wrong PIN', async () => {
    // The keypad asked the salt; a reset elsewhere minted another before the submit. The server
    // compares nothing for the stale one, and the CORRECT new PIN must then unlock.
    const d = deps([{ status: 'stale-salt' }, { status: 'ok' }], {
      saltAhead: Promise.resolve({ salt: 'salt-before-reset' }),
    });

    expect(await unlockWithPin(d)).toBe('key(salt-fresh)');
    expect(d.checkPin).toHaveBeenCalledTimes(2);
    expect(d.installDeviceKey).toHaveBeenCalledTimes(1);
    expect(d.installDeviceKey).toHaveBeenCalledWith('key(salt-fresh)');
    expect(order).not.toContain('install:key(salt-before-reset)');
  });

  it('refuses by name when the salt changes again during the retry, and installs nothing', async () => {
    const d = deps([{ status: 'stale-salt' }, { status: 'stale-salt' }]);

    expect(await failureCode(unlockWithPin(d))).toBe('pin_salt_rotated');
    expect(d.checkPin).toHaveBeenCalledTimes(2);
    expect(d.installDeviceKey).not.toHaveBeenCalled();
  });

  it('asks the salt at submit when the one asked ahead failed, and surfaces its own failure', async () => {
    const own = new Error('submit salt unreachable');
    const d = deps([], {
      saltAhead: Promise.resolve({ failure: 'prefetch offline' }),
      fetchSalt: vi.fn(async () => {
        throw own;
      }),
    });

    await expect(unlockWithPin(d)).rejects.toBe(own);
    expect(d.fetchSalt).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledWith(
      '[PIN] The salt asked ahead had failed (prefetch offline) - asking it at submit.'
    );
    expect(d.installDeviceKey).not.toHaveBeenCalled();
  });
});
