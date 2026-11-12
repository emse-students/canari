/// <reference types="jest" />

import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { subjectOfAccessToken } from './access-token';

const SECRET = 'test-secret';
const NOW = 1_800_000_000;

function sign(payload: unknown, secret = SECRET): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const refusal = (token: string) => {
  try {
    subjectOfAccessToken(token, SECRET, NOW);
  } catch (e) {
    expect(e).toBeInstanceOf(UnauthorizedException);
    return (e as UnauthorizedException).message;
  }
  throw new Error('the token was accepted');
};

describe('subjectOfAccessToken', () => {
  it('names the account of an access token', () => {
    expect(
      subjectOfAccessToken(sign({ sub: 'alice', exp: NOW + 60, type: 'access' }), SECRET, NOW)
    ).toBe('alice');
  });

  it('accepts a token that names no type, as the gateway does', () => {
    expect(subjectOfAccessToken(sign({ sub: 'alice', exp: NOW + 60 }), SECRET, NOW)).toBe('alice');
  });

  it('refuses a refresh token', () => {
    expect(refusal(sign({ sub: 'alice', exp: NOW + 60, type: 'refresh' }))).toBe(
      'Not an access token'
    );
  });

  it('refuses a token with no expiry', () => {
    expect(refusal(sign({ sub: 'alice', type: 'access' }))).toBe('JWT without an expiry');
  });

  it.each([
    ['a string', '9999999999'],
    ['null', null],
    ['zero', 0],
  ])('refuses an expiry that is %s', (_name, exp) => {
    expect(refusal(sign({ sub: 'alice', exp }))).toMatch(/expir/);
  });

  it('refuses an expired token', () => {
    expect(refusal(sign({ sub: 'alice', exp: NOW - 1 }))).toBe('JWT expired');
  });

  it.each([[undefined], [''], [42], [{ id: 'alice' }]])('refuses the subject %p', (sub) => {
    expect(refusal(sign({ sub, exp: NOW + 60 }))).toBe('JWT without a subject');
  });

  it('refuses a token signed with another secret', () => {
    expect(refusal(sign({ sub: 'alice', exp: NOW + 60 }, 'another-secret'))).toBe(
      'Invalid JWT signature'
    );
  });

  it.each([['not-a-jwt'], ['a.b'], ['a.b.c.d']])('refuses the malformed %p', (token) => {
    expect(refusal(token)).toMatch(/Malformed JWT|Invalid JWT signature/);
  });

  it('refuses a signed payload that is not an object, as a 401 and not a crash', () => {
    const head = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const body = Buffer.from('not json').toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');

    expect(refusal(`${head}.${body}.${sig}`)).toBe('Malformed JWT');
    expect(refusal(sign('text'))).toBe('Malformed JWT');
  });
});
