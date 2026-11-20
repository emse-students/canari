import { firstPinSetupFromDevice, notePinProven } from './pinFirstSetup';

function storageWith(entries: Record<string, string>): Pick<Storage, 'getItem' | 'setItem'> {
  return {
    getItem: (key: string) => entries[key] ?? null,
    setItem: (key: string, value: string) => {
      entries[key] = value;
    },
  };
}

describe('firstPinSetupFromDevice', () => {
  it('answers "returning" once the server accepted the PIN here, with no server question', () => {
    const storage = storageWith({});
    notePinProven(storage, 'u1');
    expect(firstPinSetupFromDevice(storage, 'u1')).toBe(false);
  });

  it('a device id alone proves nothing: an abandoned first setup minted it (PIN audit, 2026-11-20)', () => {
    expect(
      firstPinSetupFromDevice(storageWith({ mls_device_id_u1: 'tauri-u1-x' }), 'u1')
    ).toBeNull();
  });

  it('leaves the question to the server when this device never proved the PIN', () => {
    expect(firstPinSetupFromDevice(storageWith({}), 'u1')).toBeNull();
  });

  it("does not read another account's proof as this one's", () => {
    const storage = storageWith({});
    notePinProven(storage, 'u2');
    expect(firstPinSetupFromDevice(storage, 'u1')).toBeNull();
  });
});
