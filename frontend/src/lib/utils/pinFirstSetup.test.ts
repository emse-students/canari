import { firstPinSetupFromDevice } from './pinFirstSetup';

function storageWith(entries: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: (key: string) => entries[key] ?? null };
}

describe('firstPinSetupFromDevice', () => {
  it('answers "returning" from an enrolled device id, with no server question', () => {
    expect(firstPinSetupFromDevice(storageWith({ mls_device_id_u1: 'tauri-u1-x' }), 'u1')).toBe(
      false
    );
  });

  it('leaves the question to the server when this device never enrolled the user', () => {
    expect(firstPinSetupFromDevice(storageWith({}), 'u1')).toBeNull();
  });

  it("does not read another account's device id as this one's", () => {
    expect(
      firstPinSetupFromDevice(storageWith({ mls_device_id_u2: 'tauri-u2-x' }), 'u1')
    ).toBeNull();
  });
});
