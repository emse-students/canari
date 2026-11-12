/// <reference types="jest" />

import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { ECOSYSTEM_SITES, HandoffRefusal, type EcosystemSiteContract } from './handoff-sites';
import { HandoffService, handoffIssuer } from './handoff.service';
import {
  HandoffAccessClass,
  HandoffAccessRefused,
  type HandoffAccess,
  type HandoffAccessClassCode,
} from './handoff-access';
import { HANDOFF_TOKEN_LIFETIME_SECONDS, HANDOFF_TOKEN_TYPE } from './handoff-token';

/**
 * THE MINT (core-service's half of the sign-in handoff). Pinned: it fails closed without a key, it
 * mints only for a registered MiConnect site whose flag is on and a `dest` of its allowlist, the URL
 * is composed here with the token in the FRAGMENT, the token names the caller and nothing from the
 * body, every mint leaves one audit line, and the token itself is never in any log line.
 * What a SITE does with the token (single use, expiry, audience, replay) is `handoff-redeem.contract.spec.ts`.
 */
const keyB64 = (curve = 'P-256') =>
  generateKeyPairSync('ec', { namedCurve: curve })
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64');

const SITES: EcosystemSiteContract[] = ECOSYSTEM_SITES.map((s) =>
  s.id === 'migallery' || s.id === 'sky' ? { ...s, handoff: true } : s
);

/** MiConnect lets everybody in: the mint's own rules are what these cases pin. */
const OPEN: HandoffAccess = { assertMayEnter: () => Promise.resolve() };

const ISSUER = 'https://canari.example';
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

const tokenOf = (url: string) => new URL(url).hash.slice(1);
const decodePart = (part: string): unknown =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('HandoffService', () => {
  const saved = { key: process.env.HANDOFF_SIGNING_KEY, url: process.env.FRONTEND_URL };
  let lines: string[];

  beforeEach(() => {
    lines = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });
    }
    process.env.HANDOFF_SIGNING_KEY = keyB64();
    process.env.FRONTEND_URL = `${ISSUER},https://old.canari.example`;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [k, v] of [
      ['HANDOFF_SIGNING_KEY', saved.key],
      ['FRONTEND_URL', saved.url],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('mints a URL on the site origin, the token in the fragment, naming the caller', async () => {
    const service = new HandoffService(SITES, OPEN);
    const { url, expiresInSeconds } = await service.mint(
      'user-a',
      'migallery',
      '/mes-photos',
      NOW_MS
    );
    expect(expiresInSeconds).toBe(HANDOFF_TOKEN_LIFETIME_SECONDS);
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://gallery.mitv.fr');
    expect(parsed.pathname).toBe('/auth/handoff');
    expect(parsed.search).toBe('');
    const [h, p] = tokenOf(url).split('.');
    expect(decodePart(h)).toEqual({
      alg: 'ES256',
      typ: HANDOFF_TOKEN_TYPE,
      kid: service.jwks().keys[0].kid,
    });
    expect(decodePart(p)).toEqual({
      iss: ISSUER,
      aud: 'migallery',
      sub: 'user-a',
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      iat: NOW,
      exp: NOW + HANDOFF_TOKEN_LIFETIME_SECONDS,
      dest: '/mes-photos',
    });
  });

  it('writes one audit line per mint, and never the token', async () => {
    const service = new HandoffService(SITES, OPEN);
    const token = tokenOf((await service.mint('user-a', 'migallery', '/')).url);
    const [, , signature] = token.split('.');
    const audit = lines.filter((l) => l.startsWith('[HANDOFF] minted'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatch(/aud=migallery user=user-a jti=\S+ dest=\/$/);
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(signature);
    }
  });

  it('draws a fresh jti per mint', async () => {
    const service = new HandoffService(SITES, OPEN);
    const mints = await Promise.all(
      Array.from({ length: 50 }, () => service.mint('user-a', 'migallery', '/'))
    );
    const jtis = new Set(
      mints.map((m) => (decodePart(tokenOf(m.url).split('.')[1]) as { jti: string }).jti)
    );
    expect(jtis.size).toBe(50);
  });

  it('defaults dest to the site root', async () => {
    const service = new HandoffService(SITES, OPEN);
    const payload = decodePart(
      tokenOf((await service.mint('user-a', 'migallery', undefined)).url).split('.')[1]
    ) as { dest: string };
    expect(payload.dest).toBe('/');
  });

  it.each([
    ['an unknown site', 'evil', '/', HandoffRefusal.unknownSite],
    ['a site outside MiConnect', 'portail-etu', '/', HandoffRefusal.unknownSite],
    ['a registered site whose flag is off', 'le-cercle', '/', HandoffRefusal.siteNotEnabled],
    ['a dest outside the allowlist', 'migallery', '/admin', HandoffRefusal.badDest],
    ['a dest that is a URL', 'migallery', 'https://evil.example/', HandoffRefusal.badDest],
    ['a protocol-relative dest', 'migallery', '//evil.example', HandoffRefusal.badDest],
    ['a dest that is not a string', 'migallery', 42, HandoffRefusal.badDest],
  ])(
    'refuses %s with a typed 400, logged at warn, minting nothing',
    async (_l, aud, dest, code) => {
      const asked = jest.fn(() => Promise.resolve());
      const service = new HandoffService(SITES, { assertMayEnter: asked });
      let thrown: unknown;
      try {
        await service.mint('user-a', aud, dest);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).getResponse()).toMatchObject({ code });
      expect(lines.some((l) => l.startsWith(`[HANDOFF] refused class=${code}`))).toBe(true);
      expect(lines.some((l) => l.startsWith('[HANDOFF] minted'))).toBe(false);
      // MiConnect is asked only for a request the registry already accepted.
      expect(asked).not.toHaveBeenCalled();
    }
  );

  it('ships every site with its flag off: the contract registry mints nothing yet', async () => {
    const service = new HandoffService(undefined, OPEN);
    await expect(service.mint('user-a', 'migallery', '/')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  describe("MiConnect's door (F3-bound)", () => {
    const refusing = (accessClass: HandoffAccessClassCode) =>
      new HandoffService(SITES, {
        assertMayEnter: () => Promise.reject(new HandoffAccessRefused(accessClass, 'detail')),
      });

    it('asks MiConnect for the caller and the site application, then mints', async () => {
      const asked = jest.fn(() => Promise.resolve());
      const service = new HandoffService(SITES, { assertMayEnter: asked });
      await service.mint('user-a', 'sky', '/');
      expect(asked).toHaveBeenCalledWith('user-a', 'sky');
    });

    it.each([
      HandoffAccessClass.notLinked,
      HandoffAccessClass.unknownAccount,
      HandoffAccessClass.inactive,
      HandoffAccessClass.policyBound,
      HandoffAccessClass.defaultAccessOff,
    ])('answers %s with a typed 403, logged at warn with its class, minting nothing', async (c) => {
      let thrown: unknown;
      try {
        await refusing(c).mint('user-a', 'migallery', '/');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as ForbiddenException).getResponse()).toMatchObject({
        code: HandoffRefusal.accessRefused,
      });
      expect(lines.some((l) => l.startsWith(`[HANDOFF] refused class=${c} aud=migallery`))).toBe(
        true
      );
      expect(lines.some((l) => l.startsWith('[HANDOFF] minted'))).toBe(false);
    });

    it.each([
      HandoffAccessClass.notConfigured,
      HandoffAccessClass.unreachable,
      HandoffAccessClass.refused,
    ])('answers %s with a typed 503 - never a fallback to minting', async (c) => {
      let thrown: unknown;
      try {
        await refusing(c).mint('user-a', 'migallery', '/');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ServiceUnavailableException);
      expect((thrown as ServiceUnavailableException).getResponse()).toMatchObject({
        code: HandoffRefusal.miconnectUnavailable,
      });
      expect(lines.some((l) => l.startsWith(`[HANDOFF] refused class=${c}`))).toBe(true);
      expect(lines.some((l) => l.startsWith('[HANDOFF] minted'))).toBe(false);
    });

    it('lets an unexpected error through rather than classifying it', async () => {
      const service = new HandoffService(SITES, {
        assertMayEnter: () => Promise.reject(new Error('boom')),
      });
      await expect(service.mint('user-a', 'migallery', '/')).rejects.toThrow('boom');
      expect(lines.some((l) => l.startsWith('[HANDOFF] minted'))).toBe(false);
    });
  });

  describe('fails closed', () => {
    const notOffered = async (service: HandoffService) => {
      expect(service.offered).toBe(false);
      for (const call of [() => service.mint('user-a', 'migallery', '/'), () => service.jwks()]) {
        let thrown: unknown;
        try {
          await call();
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(NotFoundException);
        expect((thrown as NotFoundException).getResponse()).toMatchObject({
          code: HandoffRefusal.notOffered,
        });
      }
    };

    it('without a key: the configured state, said once at boot', async () => {
      delete process.env.HANDOFF_SIGNING_KEY;
      await notOffered(new HandoffService(SITES, OPEN));
      expect(lines.filter((l) => l.includes('HANDOFF_SIGNING_KEY is unset'))).toHaveLength(1);
    });

    it.each([
      ['a PEM', '-----BEGIN PRIVATE KEY-----'],
      ['garbage', 'not-a-key'],
      [
        'an RSA key',
        generateKeyPairSync('rsa', { modulusLength: 2048 })
          .privateKey.export({ format: 'der', type: 'pkcs8' })
          .toString('base64'),
      ],
      ['a P-384 key', keyB64('P-384')],
    ])('with %s as the key: said at error', async (_l, raw) => {
      process.env.HANDOFF_SIGNING_KEY = raw;
      await notOffered(new HandoffService(SITES, OPEN));
      expect(lines.some((l) => l.includes('unreadable') && l.includes('CLOSED'))).toBe(true);
    });

    it('with a SEC1 EC key (what `openssl genpkey -outform DER` writes): the format is named', async () => {
      process.env.HANDOFF_SIGNING_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ format: 'der', type: 'sec1' })
        .toString('base64');
      await notOffered(new HandoffService(SITES, OPEN));
      expect(lines.some((l) => l.includes('PKCS#8 DER private key, base64'))).toBe(true);
    });

    it('with no issuer to sign as', async () => {
      process.env.FRONTEND_URL = '';
      await notOffered(new HandoffService(SITES, OPEN));
      expect(lines.some((l) => l.includes('FRONTEND_URL names no origin'))).toBe(true);
    });
  });

  it('issues as the origin of the first FRONTEND_URL entry', () => {
    expect(handoffIssuer('https://canari.emse.fr/,https://canari-emse.fr')).toBe(
      'https://canari.emse.fr'
    );
    expect(handoffIssuer(' https://dev.canari-emse.fr ')).toBe('https://dev.canari-emse.fr');
    expect(handoffIssuer('')).toBeNull();
    expect(handoffIssuer(undefined)).toBeNull();
    expect(handoffIssuer('not a url')).toBeNull();
  });
});
