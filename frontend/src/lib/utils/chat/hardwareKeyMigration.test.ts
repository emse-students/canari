import { setKeyRecoveryHandler } from '$lib/db/deviceKeyGate';
import type {
  AtRestKeyScheme,
  HardwareKeyPort,
  HardwareKeyRead,
} from '$lib/crypto/hardwareHeldKey';
import type { LocalStateOpenResult } from '$lib/mls-client';
import {
  migrateToHardwareHeldKey,
  settleMigratingStateAtUnlock,
  startHardwareKeyMigration,
  whenHardwareKeyMigrationSettled,
} from './hardwareKeyMigration';
import { KeyChangeInterruptedError } from './pinChange';

/**
 * The move to a hardware-held key is a RE-KEY: every store re-sealed under a random key. What these
 * hold is its order - the marker says `hardware` only after everything moved - and that each way it
 * can stop leaves a state the next unlock knows how to finish.
 */

const OLD = 'old-pin-derived-key';
const NEW = 'new-hardware-key';

/** A port whose marker is `scheme`, recording every call. */
function fakePort(scheme: AtRestKeyScheme, read: HardwareKeyRead = { key: NEW }) {
  const calls: string[] = [];
  const port: HardwareKeyPort = {
    scheme: async () => {
      calls.push('scheme');
      return scheme;
    },
    prepare: async () => {
      calls.push('prepare');
      return NEW;
    },
    mark: async (_u, key) => {
      calls.push(`mark:${key}`);
    },
    read: async () => {
      calls.push('read');
      return read;
    },
  };
  return { port, calls };
}

function deps(port: HardwareKeyPort, changeKey = vi.fn(async () => {}), currentKeyB64 = OLD) {
  return { userId: 'u1', deviceId: 'd1', currentKeyB64, port, changeKey, log: () => {} };
}

let recoveries: string[] = [];
beforeEach(() => {
  recoveries = [];
  setKeyRecoveryHandler((reason) => recoveries.push(reason));
});
afterEach(() => setKeyRecoveryHandler(null));

describe('migrateToHardwareHeldKey', () => {
  it('does nothing on a phone already on the hardware-held key', async () => {
    const { port, calls } = fakePort('hardware');
    const change = vi.fn(async () => {});
    expect(await migrateToHardwareHeldKey(deps(port, change))).toBe('already-hardware');
    expect(calls).toEqual(['scheme']);
    expect(change).not.toHaveBeenCalled();
  });

  it('starts nothing when the marker cannot be read', async () => {
    const { port, calls } = fakePort('unreadable');
    expect(await migrateToHardwareHeldKey(deps(port))).toBe('refused');
    expect(calls).toEqual(['scheme']);
  });

  it('re-seals from the old key to the new one, and marks only after', async () => {
    const { port, calls } = fakePort('pin-derived');
    const change = vi.fn(async () => {
      calls.push('changeKey');
    });
    expect(await migrateToHardwareHeldKey(deps(port, change))).toBe('migrated');
    expect(change).toHaveBeenCalledWith(OLD, NEW);
    expect(calls).toEqual(['scheme', 'prepare', 'changeKey', `mark:${NEW}`]);
  });

  it('only marks when an earlier run already moved the session to the new key', async () => {
    const { port, calls } = fakePort('migrating');
    const change = vi.fn(async () => {});
    expect(await migrateToHardwareHeldKey(deps(port, change, NEW))).toBe('marked');
    expect(change).not.toHaveBeenCalled();
    expect(calls).toEqual(['scheme', 'prepare', `mark:${NEW}`]);
  });

  it('ends the session into the recovery when the interruption moved data, and never marks', async () => {
    const { port, calls } = fakePort('migrating');
    const change = vi.fn(async () => {
      throw new KeyChangeInterruptedError('stores', true, new Error('disk'));
    });
    await expect(migrateToHardwareHeldKey(deps(port, change))).rejects.toBeInstanceOf(
      KeyChangeInterruptedError
    );
    expect(recoveries).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('mark'))).toBe(false);
  });

  it('lets the session run on when the interruption moved nothing', async () => {
    const { port } = fakePort('pin-derived');
    const change = vi.fn(async () => {
      throw new KeyChangeInterruptedError('keystore', false, new Error('keystore'));
    });
    await expect(migrateToHardwareHeldKey(deps(port, change))).rejects.toThrow();
    expect(recoveries).toHaveLength(0);
  });
});

describe('startHardwareKeyMigration', () => {
  it('runs one migration at a time and never rejects', async () => {
    const { port } = fakePort('pin-derived');
    let release!: () => void;
    const change = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const first = startHardwareKeyMigration(deps(port, change));
    const second = startHardwareKeyMigration(deps(port, change));
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toBe('migrated');
    expect(await second).toBe('migrated');
    await whenHardwareKeyMigrationSettled();

    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await startHardwareKeyMigration(deps(fakePort('pin-derived').port, failing))).toBe(
      'failed'
    );
  });
});

describe('settleMigratingStateAtUnlock', () => {
  const opened: LocalStateOpenResult = { opened: true };
  const refused = { opened: false, cause: 'decrypt' } as unknown as LocalStateOpenResult;

  function settle(port: HardwareKeyPort, open: (key: string) => LocalStateOpenResult | 'no-state') {
    return settleMigratingStateAtUnlock({
      userId: 'u1',
      deviceId: 'd1',
      pinDerivedKeyB64: OLD,
      port,
      openStoredStateWith: async (key) => open(key),
      log: () => {},
    });
  }

  it('completes the marker when the new key opens the state', async () => {
    const { port, calls } = fakePort('migrating');
    expect(await settle(port, (k) => (k === NEW ? opened : refused))).toEqual({
      keyB64: NEW,
      migrationComplete: true,
    });
    expect(calls).toContain(`mark:${NEW}`);
  });

  it('keeps the PIN-derived key while the state is still under it', async () => {
    const { port, calls } = fakePort('migrating');
    expect(await settle(port, () => refused)).toEqual({ keyB64: OLD, migrationComplete: false });
    expect(calls.some((c) => c.startsWith('mark'))).toBe(false);
  });

  it('keeps the PIN-derived key when nothing is stored', async () => {
    const { port } = fakePort('migrating');
    expect(await settle(port, () => 'no-state')).toEqual({ keyB64: OLD, migrationComplete: false });
  });

  it('keeps the PIN-derived key when the new key never reached the keystore', async () => {
    const { port } = fakePort('migrating', { refusal: 'mismatch' });
    const open = vi.fn(() => opened);
    expect(await settle(port, open)).toEqual({ keyB64: OLD, migrationComplete: false });
    expect(open).not.toHaveBeenCalled();
  });
});
