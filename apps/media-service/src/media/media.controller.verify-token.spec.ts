/// <reference types="jest" />

/**
 * An unset `JWT_SECRET` is the media service's own misconfiguration: the bearer check answers 500,
 * never a 401 a client would read as its session ending (2026-11-12, the same rule as the
 * `INTERNAL_SHARED_SECRET` guards of core-, social- and chat-delivery-service).
 */
import { InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

const controller = new MediaController(
  Object.create(MediaService.prototype) as MediaService,
  {} as never,
  {} as never
);
const verify = (r: Request) =>
  (controller as unknown as { verifyToken: (r: Request) => string }).verifyToken(r);
const bearer = { headers: { authorization: 'Bearer a.b.c' } } as unknown as Request;

const prevSecret = process.env.JWT_SECRET;
afterEach(() => {
  if (prevSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = prevSecret;
});

describe('MediaController bearer check', () => {
  it('answers 500 when JWT_SECRET is unset', () => {
    delete process.env.JWT_SECRET;
    expect(() => verify(bearer)).toThrow(InternalServerErrorException);
  });

  it('still answers 401 for a missing bearer, a caller fault', () => {
    process.env.JWT_SECRET = 'test-secret';
    expect(() => verify({ headers: {} } as unknown as Request)).toThrow(UnauthorizedException);
  });
});
