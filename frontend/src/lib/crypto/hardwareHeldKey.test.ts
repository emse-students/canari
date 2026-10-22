const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  forgetHardwareHeldKeysForTest,
  HardwareKeyUnavailableError,
  isHardwareHeldDeviceKey,
  noteHardwareHeldDeviceKey,
  readHardwareHeldKey,
  tauriHardwareKeyPort,
  type HardwareKeyPort,
  type HardwareKeyRead,
} from './hardwareHeldKey';

/** The read the PIN unlock makes on a hardware-held phone: the key, or a typed refusal. */

function portReading(read: HardwareKeyRead): HardwareKeyPort {
  return {
    scheme: async () => 'hardware',
    prepare: async () => 'k',
    mark: async () => {},
    read: async () => read,
    forget: async () => {},
  };
}

afterEach(() => {
  forgetHardwareHeldKeysForTest();
  invoke.mockReset();
});

describe('readHardwareHeldKey', () => {
  it('answers the key the keystore holds', async () => {
    expect(await readHardwareHeldKey(portReading({ key: 'k1' }), 'u', () => {})).toBe('k1');
  });

  it.each(['absent', 'mismatch', 'not-hardware', 'unreadable'] as const)(
    'throws a typed error carrying the refusal (%s)',
    async (refusal) => {
      const read = readHardwareHeldKey(portReading({ refusal }), 'u', () => {});
      await expect(read).rejects.toBeInstanceOf(HardwareKeyUnavailableError);
      await expect(read).rejects.toMatchObject({ refusal });
    }
  );
});

describe('tauriHardwareKeyPort', () => {
  it('reads by account alone - the entry is the one the marker names, not one rebuilt here', async () => {
    invoke.mockResolvedValue({ status: 'key', keyB64: 'k1' });
    expect(await tauriHardwareKeyPort.read('u1')).toEqual({ key: 'k1' });
    expect(invoke).toHaveBeenCalledWith('cle_au_repos_lire', { userId: 'u1' });
    expect(isHardwareHeldDeviceKey('k1')).toBe(true);
  });

  it('types an unknown native answer as unreadable, never as a key', async () => {
    invoke.mockResolvedValue({ status: 'something-new', keyB64: null });
    expect(await tauriHardwareKeyPort.read('u1')).toEqual({ refusal: 'unreadable' });
  });

  it('forgets the marker through the explicit reset command', async () => {
    invoke.mockResolvedValue(undefined);
    await tauriHardwareKeyPort.forget('u1');
    expect(invoke).toHaveBeenCalledWith('cle_au_repos_oublier', { userId: 'u1' });
  });
});

describe('the noted hardware-held keys', () => {
  it('remembers a noted key and nothing else', () => {
    noteHardwareHeldDeviceKey('k1');
    expect(isHardwareHeldDeviceKey('k1')).toBe(true);
    expect(isHardwareHeldDeviceKey('k2')).toBe(false);
    forgetHardwareHeldKeysForTest();
    expect(isHardwareHeldDeviceKey('k1')).toBe(false);
  });
});
