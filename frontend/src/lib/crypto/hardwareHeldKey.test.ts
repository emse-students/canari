import {
  forgetHardwareHeldKeysForTest,
  HardwareKeyUnavailableError,
  isHardwareHeldDeviceKey,
  noteHardwareHeldDeviceKey,
  readHardwareHeldKey,
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
  };
}

afterEach(() => forgetHardwareHeldKeysForTest());

describe('readHardwareHeldKey', () => {
  it('answers the key the keystore holds', async () => {
    expect(await readHardwareHeldKey(portReading({ key: 'k1' }), 'u', 'd', () => {})).toBe('k1');
  });

  it.each(['absent', 'mismatch', 'not-hardware', 'unreadable'] as const)(
    'throws a typed error carrying the refusal (%s)',
    async (refusal) => {
      const read = readHardwareHeldKey(portReading({ refusal }), 'u', 'd', () => {});
      await expect(read).rejects.toBeInstanceOf(HardwareKeyUnavailableError);
      await expect(read).rejects.toMatchObject({ refusal });
    }
  );
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
