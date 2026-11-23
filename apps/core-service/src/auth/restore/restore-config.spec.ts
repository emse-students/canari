/// <reference types="jest" />

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apkKeyHashOrigin, readRestoreConfig } from './restore-config';

/**
 * Shared with the app's own read of its signer (`RestoreOriginTest.kt` over `ApkKeyHash.origin`):
 * the same certificate must give the same origin on both sides, or the client decides against an
 * origin this server never sees (docs/wiki/account-restore.md).
 */
const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../../libs/contracts/restore-apk-key-hash.cases.json'),
    'utf8'
  )
) as { cases: { name: string; derHex: string; fingerprint: string; origin: string }[] };

const HEX = 'AB'.repeat(32);
const COLONS = HEX.match(/.{2}/g)!.join(':');
const ORIGIN = `android:apk-key-hash:${Buffer.alloc(32, 0xab).toString('base64url')}`;

describe('restore configuration', () => {
  it('turns a fingerprint into the apk-key-hash origin, with or without colons, in any case', () => {
    expect(apkKeyHashOrigin(COLONS)).toBe(ORIGIN);
    expect(apkKeyHashOrigin(HEX)).toBe(ORIGIN);
    expect(apkKeyHashOrigin(COLONS.toLowerCase())).toBe(ORIGIN);
  });

  it('gives the shared contract origin, the one the app computes from the certificate DER', () => {
    expect(CONTRACT.cases.length).toBeGreaterThan(0);
    for (const c of CONTRACT.cases) {
      // The fingerprint IS the DER's SHA-256: the vector is consistent before either side reads it.
      expect(c.fingerprint.replace(/:/g, '').toLowerCase()).toBe(
        createHash('sha256').update(Buffer.from(c.derHex, 'hex')).digest('hex')
      );
      expect(apkKeyHashOrigin(c.fingerprint)).toBe(c.origin);
    }
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
