/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { createPublicKey, generateKeyPairSync, verify, type webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ECOSYSTEM_SITES, type EcosystemSiteContract } from './handoff-sites';
import { HandoffService } from './handoff.service';
import {
  HANDOFF_TOKEN_ALG,
  HANDOFF_TOKEN_LIFETIME_SECONDS,
  HANDOFF_TOKEN_TYPE,
} from './handoff-token';

/**
 * THE REDEMPTION CONTRACT A SITE IMPLEMENTS, executed here against tokens this service mints and
 * against `libs/contracts/handoff-token.cases.json`
 * (docs/wiki/backlog.d/sign-in-handoff-to-the-ecosystem-sites-and-migallery-notifications.md,
 * "The contract MiGallery implements").
 *
 * {@link verifyHandoff} below is the REFERENCE: the steps in the contract's order, each ending in
 * the outcome the contract names. It lives in this spec, not in `src`, because Canari never
 * redeems; a site writes its own (with `jose`) and must answer every vector the way this one does.
 */

/** What a redemption answers. Every refusal is a class, logged by the site, never the token. */
type Outcome =
  | { outcome: 'ok'; sub: string; dest: string; jti: string }
  | {
      outcome:
        | 'invalid'
        | 'wrong_issuer'
        | 'wrong_audience'
        | 'expired'
        | 'not_yet_valid'
        | 'too_long'
        | 'bad_dest'
        | 'replayed';
    };

interface VerifyConfig {
  issuer: string;
  audience: string;
  jwks: { keys: Array<Record<string, unknown>> };
  /** Seconds since the epoch. */
  now: number;
  /** The site's `handoff_redemptions` table: `jti` is its primary key. */
  ledger: Set<string>;
}

const LEEWAY_SECONDS = 30;

const decodePart = (part: string): unknown =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** MiGallery-shaped: a same-origin path only (its `safeRedirectTarget` refuses more). */
const siteRedirectAllows = (dest: string) =>
  dest.startsWith('/') && !dest.startsWith('//') && !dest.includes('\\');

function verifyHandoff(token: string, cfg: VerifyConfig): Outcome {
  // 1. Parse; typ; alg in {ES256}; kid in the JWKS; signature.
  const parts = token.split('.');
  if (parts.length !== 3) return { outcome: 'invalid' };
  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = decodePart(parts[0]) as typeof header;
    payload = decodePart(parts[1]) as typeof payload;
  } catch {
    return { outcome: 'invalid' };
  }
  if (header.typ !== HANDOFF_TOKEN_TYPE || header.alg !== HANDOFF_TOKEN_ALG) {
    return { outcome: 'invalid' };
  }
  const jwk = cfg.jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { outcome: 'invalid' };
  const key = createPublicKey({ key: jwk as webcrypto.JsonWebKey, format: 'jwk' });
  const signed = verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[2], 'base64url')
  );
  if (!signed) return { outcome: 'invalid' };
  const { iss, aud, sub, jti, iat, exp, dest } = payload;
  if (
    typeof iss !== 'string' ||
    typeof aud !== 'string' ||
    typeof sub !== 'string' ||
    typeof jti !== 'string' ||
    typeof dest !== 'string' ||
    typeof iat !== 'number' ||
    typeof exp !== 'number'
  ) {
    return { outcome: 'invalid' };
  }
  // 2. Issuer, audience.
  if (iss !== cfg.issuer) return { outcome: 'wrong_issuer' };
  if (aud !== cfg.audience) return { outcome: 'wrong_audience' };
  // 3. Time, with the leeway; a lifetime over the maximum is refused whatever the clock says.
  if (exp - iat > HANDOFF_TOKEN_LIFETIME_SECONDS) return { outcome: 'too_long' };
  if (cfg.now > exp + LEEWAY_SECONDS) return { outcome: 'expired' };
  if (iat > cfg.now + LEEWAY_SECONDS) return { outcome: 'not_yet_valid' };
  // 4. The site's own redirect validator, even though Canari signed the dest.
  if (!siteRedirectAllows(dest)) return { outcome: 'bad_dest' };
  // 5. Single use from durable state: the INSERT is the decision.
  if (cfg.ledger.has(jti)) return { outcome: 'replayed' };
  cfg.ledger.add(jti);
  return { outcome: 'ok', sub, dest, jti };
}

describe('libs/contracts/handoff-token.cases.json', () => {
  const vectors = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        '..',
        'libs',
        'contracts',
        'handoff-token.cases.json'
      ),
      'utf8'
    )
  ) as {
    issuer: string;
    audience: string;
    leewaySeconds: number;
    maxLifetimeSeconds: number;
    jwks: VerifyConfig['jwks'];
    cases: Array<{ name: string; token: string; now: number; expect: string; sub?: string }>;
    replay: { token: string; now: number; expect: string[] };
  };
  const cfg = (now: number, ledger = new Set<string>()): VerifyConfig => ({
    issuer: vectors.issuer,
    audience: vectors.audience,
    jwks: vectors.jwks,
    now,
    ledger,
  });

  it('states the bounds this service mints under', () => {
    expect(vectors.leewaySeconds).toBe(LEEWAY_SECONDS);
    expect(vectors.maxLifetimeSeconds).toBe(HANDOFF_TOKEN_LIFETIME_SECONDS);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = verifyHandoff(c.token, cfg(c.now));
    expect(result.outcome).toBe(c.expect);
    expect(result.outcome === 'ok' ? result.sub : undefined).toBe(c.sub);
  });

  it('replay: the same token against one ledger is ok, then replayed', () => {
    const ledger = new Set<string>();
    const outcomes = vectors.replay.expect.map(
      () => verifyHandoff(vectors.replay.token, cfg(vectors.replay.now, ledger)).outcome
    );
    expect(outcomes).toEqual(vectors.replay.expect);
  });
});

describe('a token this service mints, redeemed by a site', () => {
  const ISSUER = 'https://canari.example';
  const NOW_MS = 1_800_000_000_000;
  const NOW = NOW_MS / 1000;
  const SITES: EcosystemSiteContract[] = ECOSYSTEM_SITES.map((s) =>
    s.id === 'migallery' || s.id === 'sky' ? { ...s, handoff: true } : s
  );
  const keyB64 = () =>
    generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
  const tokenOf = (url: string) => new URL(url).hash.slice(1);
  const saved = { key: process.env.HANDOFF_SIGNING_KEY, url: process.env.FRONTEND_URL };

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    process.env.HANDOFF_SIGNING_KEY = keyB64();
    process.env.FRONTEND_URL = ISSUER;
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

  const migallery = (service: HandoffService, ledger = new Set<string>(), now = NOW) => ({
    issuer: ISSUER,
    audience: 'migallery',
    jwks: service.jwks() as unknown as VerifyConfig['jwks'],
    now,
    ledger,
  });

  it('is redeemed once, and a replay is refused', () => {
    const service = new HandoffService(SITES);
    const token = tokenOf(service.mint('user-a', 'migallery', '/mes-photos', NOW_MS).url);
    const ledger = new Set<string>();
    expect(verifyHandoff(token, migallery(service, ledger))).toMatchObject({
      outcome: 'ok',
      sub: 'user-a',
      dest: '/mes-photos',
    });
    expect(verifyHandoff(token, migallery(service, ledger))).toEqual({ outcome: 'replayed' });
  });

  it('expires: honoured within the leeway, refused past it', () => {
    const service = new HandoffService(SITES);
    const token = tokenOf(service.mint('user-a', 'migallery', '/', NOW_MS).url);
    const exp = NOW + HANDOFF_TOKEN_LIFETIME_SECONDS;
    expect(verifyHandoff(token, migallery(service, new Set(), exp + 30)).outcome).toBe('ok');
    expect(verifyHandoff(token, migallery(service, new Set(), exp + 31)).outcome).toBe('expired');
  });

  it('is bound to its audience: a Sky token is refused by MiGallery', () => {
    const service = new HandoffService(SITES);
    const token = tokenOf(service.mint('user-a', 'sky', '/', NOW_MS).url);
    expect(verifyHandoff(token, migallery(service)).outcome).toBe('wrong_audience');
  });

  it('is bound to its user: a sub edited to another account fails the signature', () => {
    const service = new HandoffService(SITES);
    const [h, p, s] = tokenOf(service.mint('user-a', 'migallery', '/', NOW_MS).url).split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...(decodePart(p) as object), sub: 'user-b' })
    ).toString('base64url');
    expect(verifyHandoff(`${h}.${forged}.${s}`, migallery(service)).outcome).toBe('invalid');
  });

  it('is wrong_issuer at a site that trusts another estate (dev token, production site)', () => {
    process.env.FRONTEND_URL = 'https://dev.canari.example';
    const dev = new HandoffService(SITES);
    const token = tokenOf(dev.mint('user-a', 'migallery', '/', NOW_MS).url);
    expect(verifyHandoff(token, migallery(dev)).outcome).toBe('wrong_issuer');
  });

  it('is invalid under a key the site does not hold (a foreign or rotated-out signer)', () => {
    const service = new HandoffService(SITES);
    process.env.HANDOFF_SIGNING_KEY = keyB64();
    const other = new HandoffService(SITES);
    const token = tokenOf(other.mint('user-a', 'migallery', '/', NOW_MS).url);
    expect(verifyHandoff(token, migallery(service)).outcome).toBe('invalid');
  });
});
