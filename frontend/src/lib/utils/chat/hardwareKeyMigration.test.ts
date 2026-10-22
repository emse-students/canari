import { setKeyRecoveryHandler } from '$lib/db/deviceKeyGate';
import {
  HardwareKeyUnavailableError,
  type AtRestKeyScheme,
  type HardwareKeyPort,
  type HardwareKeyRead,
} from '$lib/crypto/hardwareHeldKey';
import type { LocalStateOpenResult } from '$lib/mls-client';
import {
  finishMigrationAtUnlock,
  migrateToHardwareHeldKey,
  settledAtRestScheme,
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
    forget: async () => {
      calls.push('forget');
    },
  };
  return { port, calls };
}

/** Decision 4's two hooks: whether the install held data, and what was told when it did. */
let hadLocalData = true;
let superseded = 0;
const backupNotice = {
  hadLocalData: async () => hadLocalData,
  onBackupsSuperseded: () => {
    superseded++;
  },
};

function deps(port: HardwareKeyPort, changeKey = vi.fn(async () => {}), currentKeyB64 = OLD) {
  return {
    userId: 'u1',
    deviceId: 'd1',
    currentKeyB64,
    port,
    changeKey,
    ...backupNotice,
    log: () => {},
  };
}

let recoveries: string[] = [];
beforeEach(() => {
  recoveries = [];
  hadLocalData = true;
  superseded = 0;
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

  it('asks for a new backup after a re-key of an install that held data, and only then', async () => {
    expect(await migrateToHardwareHeldKey(deps(fakePort('pin-derived').port))).toBe('migrated');
    expect(superseded).toBe(1);

    // A fresh install takes the same path and has no earlier backup to supersede.
    hadLocalData = false;
    expect(await migrateToHardwareHeldKey(deps(fakePort('pin-derived').port))).toBe('migrated');
    expect(superseded).toBe(1);
  });

  it('asks for nothing when the re-key did not finish', async () => {
    const change = vi.fn(async () => {
      throw new KeyChangeInterruptedError('stores', true, new Error('disk'));
    });
    await expect(
      migrateToHardwareHeldKey(deps(fakePort('pin-derived').port, change))
    ).rejects.toThrow();
    expect(superseded).toBe(0);
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

describe('settledAtRestScheme', () => {
  it('reads the scheme only once the re-key running in this page has finished', async () => {
    const order: string[] = [];
    const { port } = fakePort('pin-derived');
    let release!: () => void;
    const change = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('re-key done');
            resolve();
          };
        })
    );
    const migration = startHardwareKeyMigration(deps(port, change));
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1));

    const reader = {
      scheme: vi.fn(async (): Promise<AtRestKeyScheme> => {
        order.push('scheme read');
        return 'hardware';
      }),
    };
    const read = settledAtRestScheme(reader, 'u1');
    await Promise.resolve();
    expect(reader.scheme).not.toHaveBeenCalled();

    release();
    expect(await read).toBe('hardware');
    expect(await migration).toBe('migrated');
    expect(order).toEqual(['re-key done', 'scheme read']);
  });

  it('reads at once when nothing is running', async () => {
    const reader = { scheme: vi.fn(async () => 'pin-derived' as const) };
    expect(await settledAtRestScheme(reader, 'u1')).toBe('pin-derived');
    expect(reader.scheme).toHaveBeenCalledWith('u1');
  });
});

/**
 * A KILL IN THE STORE PASS LEAVES ROWS UNDER TWO KEYS, and no session may run over that. These hold
 * that the unlock FINISHES the re-key before handing back a key, whichever step it stopped at.
 */
describe('finishMigrationAtUnlock', () => {
  const opened: LocalStateOpenResult = { opened: true };
  const refused = { opened: false, cause: 'undecryptable' } as unknown as LocalStateOpenResult;
  const STATE = new Uint8Array([1, 2, 3]);

  function finish(
    port: HardwareKeyPort,
    calls: string[],
    opts: {
      state?: Uint8Array | null;
      open?: (key: string) => LocalStateOpenResult;
      reKey?: () => Promise<void>;
    } = {}
  ) {
    return finishMigrationAtUnlock({
      userId: 'u1',
      pinDerivedKeyB64: OLD,
      port,
      loadStoredState: async () => (opts.state === undefined ? STATE : opts.state),
      openStoredStateWith: async (key) => (opts.open ?? (() => refused))(key),
      completeReKey: async (from, to, state) => {
        calls.push(`reKey:${from}->${to}:${state.length}`);
        await opts.reKey?.();
      },
      resealStoresOnly: async (from, to) => {
        calls.push(`stores:${from}->${to}`);
      },
      ...backupNotice,
      log: () => {},
    });
  }

  it('asks for a new backup once an interrupted re-key of an install with data is finished', async () => {
    const { port, calls } = fakePort('migrating');
    await finish(port, calls);
    expect(superseded).toBe(1);
  });

  it('only completes the marker when the new key already opens the state', async () => {
    const { port, calls } = fakePort('migrating');
    expect(await finish(port, calls, { open: (k) => (k === NEW ? opened : refused) })).toBe(NEW);
    expect(calls).toEqual(['read', `mark:${NEW}`]);
  });

  it('finishes the re-key from the stored state before answering, then marks', async () => {
    const { port, calls } = fakePort('migrating');
    expect(await finish(port, calls)).toBe(NEW);
    expect(calls).toEqual(['read', `reKey:${OLD}->${NEW}:3`, `mark:${NEW}`]);
  });

  it('moves the stores alone when no MLS state is stored', async () => {
    const { port, calls } = fakePort('migrating');
    expect(await finish(port, calls, { state: null })).toBe(NEW);
    expect(calls).toEqual(['read', `stores:${OLD}->${NEW}`, `mark:${NEW}`]);
  });

  it('restarts the page when finishing stops after data moved, and never marks', async () => {
    const { port, calls } = fakePort('migrating');
    const reKey = async () => {
      throw new KeyChangeInterruptedError('stores', true, new Error('disk'));
    };
    await expect(finish(port, calls, { reKey })).rejects.toBeInstanceOf(KeyChangeInterruptedError);
    expect(recoveries).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('mark'))).toBe(false);
  });

  it('throws without a restart when finishing fails before anything moved', async () => {
    const { port, calls } = fakePort('migrating');
    const reKey = async () => {
      throw new KeyChangeInterruptedError('keystore', false, new Error('keystore'));
    };
    await expect(finish(port, calls, { reKey })).rejects.toThrow();
    expect(recoveries).toHaveLength(0);
    expect(calls.some((c) => c.startsWith('mark'))).toBe(false);
  });

  it('never falls back to the PIN-derived key when the keystore refuses the new one', async () => {
    const { port, calls } = fakePort('migrating', { refusal: 'unreadable' });
    await expect(finish(port, calls)).rejects.toBeInstanceOf(HardwareKeyUnavailableError);
    expect(calls).toEqual(['read']);
  });
});
