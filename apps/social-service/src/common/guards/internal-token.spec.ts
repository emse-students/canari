/// <reference types="jest" />

import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { verifyInternalToken } from './internal-token';

const SECRET = 'my-secret';
const userId = 'alice';

function makeToken(id: string, minuteOffset = 0): string {
  const min = Math.floor(Date.now() / 60000) + minuteOffset;
  return createHmac('sha256', SECRET).update(`${id}:${min}`).digest('hex');
}

function headers(token: string | undefined): Record<string, unknown> {
  return token === undefined ? {} : { 'x-internal-token': token };
}

describe('verifyInternalToken', () => {
  it('passes with a current-minute token', () => {
    expect(() => verifyInternalToken(headers(makeToken(userId)), userId, SECRET)).not.toThrow();
  });

  it('passes with a previous-minute token (clock skew)', () => {
    expect(() => verifyInternalToken(headers(makeToken(userId, -1)), userId, SECRET)).not.toThrow();
  });

  it('refuses a token from two minutes ago', () => {
    expect(() => verifyInternalToken(headers(makeToken(userId, -2)), userId, SECRET)).toThrow(
      UnauthorizedException
    );
  });

  it('refuses a token minted for another user', () => {
    expect(() => verifyInternalToken(headers(makeToken('bob')), userId, SECRET)).toThrow(
      UnauthorizedException
    );
  });

  it('refuses an absent or blank header', () => {
    expect(() => verifyInternalToken(headers(undefined), userId, SECRET)).toThrow(
      UnauthorizedException
    );
    expect(() => verifyInternalToken(headers('   '), userId, SECRET)).toThrow(
      UnauthorizedException
    );
  });

  it('refuses a header that is not hex', () => {
    expect(() => verifyInternalToken(headers('zzzzzz'), userId, SECRET)).toThrow(
      UnauthorizedException
    );
  });
});
