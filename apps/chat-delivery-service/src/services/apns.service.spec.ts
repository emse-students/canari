/// <reference types="jest" />

import * as crypto from 'crypto';
import { ApnsService } from './apns.service';
import { ApnsRequest } from './push-payload';

const APNS_ENV = [
  'APNS_AUTH_KEY',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_PRODUCTION',
];

/** Generates a throwaway EC P-256 key pair in .p8 (PKCS#8 PEM) form. */
function makeKeyPair(): { pem: string; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey,
  };
}

describe('ApnsService', () => {
  let service: ApnsService;

  beforeEach(() => {
    for (const k of APNS_ENV) delete process.env[k];
    service = new ApnsService();
  });

  afterEach(() => {
    for (const k of APNS_ENV) delete process.env[k];
  });

  describe('inert when unconfigured', () => {
    it('reports not configured', () => {
      expect(service.isConfigured()).toBe(false);
      expect(service.getProviderToken()).toBeNull();
    });

    it('skips sends without any network call', async () => {
      const req: ApnsRequest = {
        payload: { aps: { 'content-available': 1 } },
        pushType: 'background',
        priority: 5,
      };
      const res = await service.sendDataNotification('devicetoken', req);
      expect(res).toEqual({ skipped: true });
    });
  });

  describe('provider token when configured', () => {
    let publicKey: crypto.KeyObject;

    beforeEach(() => {
      const kp = makeKeyPair();
      publicKey = kp.publicKey;
      process.env.APNS_AUTH_KEY = kp.pem;
      process.env.APNS_KEY_ID = 'KEY123ABC';
      process.env.APNS_TEAM_ID = 'TEAM456DEF';
    });

    it('is configured', () => {
      expect(service.isConfigured()).toBe(true);
    });

    it('signs a verifiable ES256 JWT with the expected header and claims', () => {
      const token = service.getProviderToken();
      expect(token).not.toBeNull();
      const [headerB64, claimsB64, sigB64] = token.split('.');

      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) as {
        alg: string;
        kid: string;
      };
      const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString()) as {
        iss: string;
        iat: number;
      };
      expect(header).toEqual({ alg: 'ES256', kid: 'KEY123ABC' });
      expect(claims.iss).toBe('TEAM456DEF');
      expect(typeof claims.iat).toBe('number');

      const verified = crypto.verify(
        'SHA256',
        Buffer.from(`${headerB64}.${claimsB64}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(sigB64, 'base64url')
      );
      expect(verified).toBe(true);
    });

    it('caches the provider token across calls', () => {
      expect(service.getProviderToken()).toBe(service.getProviderToken());
    });
  });
});
