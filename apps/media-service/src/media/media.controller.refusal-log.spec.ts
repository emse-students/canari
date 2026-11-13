/// <reference types="jest" />

/**
 * A refused request leaves a line on the server: Nest logs no HttpException and this service has no
 * exception filter, so the controller says each 401 itself, with the check that refused and never
 * the token.
 */
import * as crypto from 'crypto';
import { InternalServerErrorException, Logger, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { MediaController } from './media.controller';

const SECRET = 'test-secret';

function token(payload: object, secret = SECRET): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const verify = (authorization?: string): string =>
  (
    new MediaController({} as never, {} as never, {} as never) as unknown as {
      verifyToken: (req: Request) => string;
    }
  ).verifyToken({ headers: { authorization } } as unknown as Request);

const prevSecret = process.env.JWT_SECRET;
let warn: jest.SpyInstance;
beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  if (prevSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = prevSecret;
});

describe('a refused request', () => {
  it.each([
    ['no bearer', undefined, 'Missing Bearer token'],
    [
      'a refresh token',
      token({ sub: 'a', exp: 4_000_000_000, type: 'refresh' }),
      'Not an access token',
    ],
    ['an expired token', token({ sub: 'a', exp: 1 }), 'JWT expired'],
    ['no expiry', token({ sub: 'a' }), 'JWT without an expiry'],
    [
      'another signature',
      token({ sub: 'a', exp: 4_000_000_000 }, 'other'),
      'Invalid JWT signature',
    ],
  ])('with %s is logged once, naming the check and not the token', (_name, jwt, check) => {
    expect(() => verify(jwt === undefined ? undefined : `Bearer ${jwt}`)).toThrow(
      UnauthorizedException
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[auth] request refused, 401: ${check}`);
    expect(String(warn.mock.calls[0][0])).not.toContain(jwt ?? 'no token was sent');
  });

  it('is logged at ERROR, as a 500, when the secret is missing - a fault of the service, never a 401', () => {
    delete process.env.JWT_SECRET;
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    try {
      expect(() => verify(`Bearer ${token({ sub: 'a', exp: 4_000_000_000 })}`)).toThrow(
        InternalServerErrorException
      );
      expect(error).toHaveBeenCalledWith(
        '[AUTH] JWT_SECRET is not configured - refusing the request'
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe('an accepted request', () => {
  it('logs nothing and names its account', () => {
    expect(verify(`Bearer ${token({ sub: 'alice', exp: 4_000_000_000 })}`)).toBe('alice');
    expect(warn).not.toHaveBeenCalled();
  });
});
