import { describe, expect, it } from 'vitest';
import { keyFingerprint } from './callKeys';

describe('keyFingerprint', () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
  const keyPrefix = Array.from(key.slice(0, 4))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  it('is the first 4 bytes of the SHA-256 of the key, in hex', async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
    const expected = Array.from(digest.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(await keyFingerprint(key)).toBe(expected);
    expect(await keyFingerprint(key)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('never prints the key bytes themselves - what the old fp= line did', async () => {
    expect(await keyFingerprint(key)).not.toBe(keyPrefix);
  });

  it('is the same for the same key on two devices, and differs for another key', async () => {
    expect(await keyFingerprint(Uint8Array.from(key))).toBe(await keyFingerprint(key));
    const other = Uint8Array.from(key);
    other[31] ^= 1;
    expect(await keyFingerprint(other)).not.toBe(await keyFingerprint(key));
  });
});
