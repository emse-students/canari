import { computePinVerifier } from '$lib/utils/chat/auth';
import { encryptData, decryptData } from '$lib/encryption';
import { deriveDeviceKeyB64, isValidDeviceKeyB64 } from './deviceKey';

const USER = 'alice';
const PIN = '1234';
const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('deriveDeviceKeyB64', () => {
  it('produces exactly 32 bytes of base64', async () => {
    const key = await deriveDeviceKeyB64(USER, PIN, SALT);
    expect(atob(key)).toHaveLength(32);
    expect(isValidDeviceKeyB64(key)).toBe(true);
  });

  it('is deterministic: the same inputs re-derive the same key', async () => {
    // This is what lets a device re-derive its key at every login without storing the PIN.
    const [a, b] = await Promise.all([
      deriveDeviceKeyB64(USER, PIN, SALT),
      deriveDeviceKeyB64(USER, PIN, SALT),
    ]);
    expect(a).toBe(b);
  });

  it('changes when the PIN, the user, or the salt changes', async () => {
    const base = await deriveDeviceKeyB64(USER, PIN, SALT);
    const otherPin = await deriveDeviceKeyB64(USER, '5678', SALT);
    const otherUser = await deriveDeviceKeyB64('bob', PIN, SALT);
    const otherSalt = await deriveDeviceKeyB64(USER, PIN, 'ffffffffffffffffffffffffffffffff');
    expect(new Set([base, otherPin, otherUser, otherSalt]).size).toBe(4);
  });

  it('never equals the PIN verifier sent to the server', async () => {
    // The verifier is stored server-side. If the device key matched it, the server would hold
    // a copy of the key that decrypts every local secret.
    const key = await deriveDeviceKeyB64(USER, PIN, SALT);
    const verifier = await computePinVerifier(USER, PIN, SALT);
    const keyHex = Array.from(atob(key), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(
      ''
    );
    expect(keyHex).not.toBe(verifier);
  });

  it('yields a key AES-256-GCM accepts, and a different PIN cannot decrypt', async () => {
    const key = await deriveDeviceKeyB64(USER, PIN, SALT);
    const { iv, cipherText } = await encryptData({ hello: 'world' }, key);
    await expect(decryptData(cipherText, iv, key)).resolves.toEqual({ hello: 'world' });

    const wrongKey = await deriveDeviceKeyB64(USER, '9999', SALT);
    await expect(decryptData(cipherText, iv, wrongKey)).rejects.toThrow();
  });
});

describe('isValidDeviceKeyB64', () => {
  it('rejects a raw PIN, empty values, and non-base64 junk', () => {
    // Builds before the derivation existed vaulted the raw PIN under the device-key slot.
    expect(isValidDeviceKeyB64('1234')).toBe(false);
    expect(isValidDeviceKeyB64('')).toBe(false);
    expect(isValidDeviceKeyB64(null)).toBe(false);
    expect(isValidDeviceKeyB64(undefined)).toBe(false);
    expect(isValidDeviceKeyB64('not base64 !!')).toBe(false);
  });

  it('rejects base64 that decodes to the wrong length', () => {
    expect(isValidDeviceKeyB64(btoa('a'.repeat(16)))).toBe(false);
    expect(isValidDeviceKeyB64(btoa('a'.repeat(64)))).toBe(false);
    expect(isValidDeviceKeyB64(btoa('a'.repeat(32)))).toBe(true);
  });
});
