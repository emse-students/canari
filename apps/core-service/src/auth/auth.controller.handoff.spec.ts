/// <reference types="jest" />

/**
 * THE TWO HANDOFF ROUTES (`POST /api/auth/handoff`, `GET /api/auth/handoff/jwks`), through the
 * controller. Pinned: the route says `HANDOFF_NOT_OFFERED` before asking for a token where the
 * estate has no key; a mint needs an access token of a LIVE session (an ended one mints nothing); a
 * refresh token is not an access token; the subject is the token's and never the body's; the JWKS is
 * cacheable.
 */
import { Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { generateKeyPairSync } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { AuthController } from './auth.controller';
import { ECOSYSTEM_SITES } from './handoff/handoff-sites';
import { HandoffService } from './handoff/handoff.service';

const JWT_SECRET = 'test-secret-not-the-production-one';

const req = (headers: Record<string, string> = {}) =>
  ({ headers, cookies: {}, get: () => undefined }) as unknown as Request;

const bearer = (claims: Record<string, unknown>) => ({
  authorization: `Bearer ${jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' })}`,
});

const payloadOf = (url: string) =>
  JSON.parse(Buffer.from(new URL(url).hash.slice(1).split('.')[1], 'base64url').toString('utf8'));

function build(opts: { key?: boolean; live?: boolean } = {}) {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.ALLOW_INSECURE_COOKIES = 'false';
  process.env.FRONTEND_URL = 'https://canari.example';
  if (opts.key === false) delete process.env.HANDOFF_SIGNING_KEY;
  else {
    process.env.HANDOFF_SIGNING_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
  }
  const handoff = new HandoffService(
    ECOSYSTEM_SITES.map((s) => (s.id === 'migallery' ? { ...s, handoff: true } : s))
  );
  const sessions = { isLive: jest.fn(async () => opts.live ?? true) };
  const controller = new AuthController(
    { findOne: jest.fn() } as never,
    { getConfig: jest.fn(), isAccessBlockedByMaintenance: jest.fn() } as never,
    sessions as never,
    { enabled: false } as never,
    {
      erasureState: jest.fn().mockResolvedValue('none'),
      confirmAfterSignIn: jest.fn().mockResolvedValue('none'),
    } as never,
    {} as never, // RestoreCredentialsService: no restore route here
    handoff
  );
  return { controller, sessions };
}

describe('Handoff routes', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const k of [
      'JWT_SECRET',
      'ALLOW_INSECURE_COOKIES',
      'FRONTEND_URL',
      'HANDOFF_SIGNING_KEY',
    ]) {
      delete process.env[k];
    }
  });

  it('mints for the subject of a live access token', async () => {
    const { controller, sessions } = build();
    const { url } = await controller.mintHandoff(req(bearer({ sub: 'user-a', sid: 's1' })), {
      aud: 'migallery',
      dest: '/mes-photos',
    });
    expect(sessions.isLive).toHaveBeenCalledWith('s1', 'user-a');
    expect(payloadOf(url)).toMatchObject({ sub: 'user-a', aud: 'migallery', dest: '/mes-photos' });
  });

  it('takes the subject from the token, never from the body', async () => {
    const { controller } = build();
    const body = { aud: 'migallery', dest: '/', sub: 'user-b' } as never;
    const { url } = await controller.mintHandoff(req(bearer({ sub: 'user-a', sid: 's1' })), body);
    expect(payloadOf(url).sub).toBe('user-a');
  });

  it('mints nothing for an ended session', async () => {
    const { controller } = build({ live: false });
    await expect(
      controller.mintHandoff(req(bearer({ sub: 'user-a', sid: 's1' })), { aud: 'migallery' })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('mints nothing without a token, or for a refresh token', async () => {
    const { controller } = build();
    await expect(controller.mintHandoff(req(), { aud: 'migallery' })).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(
      controller.mintHandoff(req(bearer({ sub: 'user-a', sid: 's1', type: 'refresh' })), {
        aud: 'migallery',
      })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers 404 HANDOFF_NOT_OFFERED where the estate has no key, before reading a token', async () => {
    const { controller, sessions } = build({ key: false });
    await expect(controller.mintHandoff(req(), { aud: 'migallery' })).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(sessions.isLive).not.toHaveBeenCalled();
    expect(() => controller.handoffJwks({ set: jest.fn() } as unknown as Response)).toThrow(
      NotFoundException
    );
  });

  it('serves the JWKS, cacheable', () => {
    const { controller } = build();
    const set = jest.fn();
    const jwks = controller.handoffJwks({ set } as unknown as Response);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0]).not.toHaveProperty('d');
    expect(set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=300');
  });
});
