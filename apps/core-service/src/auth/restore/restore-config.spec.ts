/// <reference types="jest" />

import { apkKeyHashOrigin, readRestoreConfig } from './restore-config';

const HEX = 'AB'.repeat(32);
const COLONS = HEX.match(/.{2}/g)!.join(':');
const ORIGIN = `android:apk-key-hash:${Buffer.alloc(32, 0xab).toString('base64url')}`;

describe('restore configuration', () => {
  it('turns a fingerprint into the apk-key-hash origin, with or without colons, in any case', () => {
    expect(apkKeyHashOrigin(COLONS)).toBe(ORIGIN);
    expect(apkKeyHashOrigin(HEX)).toBe(ORIGIN);
    expect(apkKeyHashOrigin(COLONS.toLowerCase())).toBe(ORIGIN);
  });

  it('refuses a value that is not a SHA-256 fingerprint rather than accepting an origin that never matches', () => {
    expect(() => apkKeyHashOrigin('AB:CD')).toThrow(/not a SHA-256 fingerprint/);
    expect(() => apkKeyHashOrigin('ZZ'.repeat(32))).toThrow(/not a SHA-256 fingerprint/);
  });

  it('splits the list the way the frontend splits it, and de-duplicates', () => {
    const other = 'CD'.repeat(32);
    const config = readRestoreConfig(`${COLONS}, ${HEX}\n${other}`, 'https://canari.emse.fr');
    expect(config).toEqual({
      available: true,
      rpId: 'canari.emse.fr',
      origins: [ORIGIN, apkKeyHashOrigin(other)],
    });
  });

  it('takes the RP id from the FIRST entry of FRONTEND_URL, the canonical name', () => {
    const config = readRestoreConfig(HEX, 'https://canari.emse.fr/,https://canari-emse.fr');
    expect(config.available && config.rpId).toBe('canari.emse.fr');
  });

  it('fails closed with no fingerprint', () => {
    expect(readRestoreConfig('', 'https://canari.emse.fr')).toEqual({
      available: false,
      reason: 'ANDROID_APP_LINK_SHA256 is empty',
    });
    expect(readRestoreConfig(undefined, 'https://canari.emse.fr').available).toBe(false);
  });

  it('fails closed with no usable FRONTEND_URL', () => {
    expect(readRestoreConfig(HEX, '').available).toBe(false);
    expect(readRestoreConfig(HEX, 'not a url').available).toBe(false);
  });
});
