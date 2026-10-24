import { BadRequestException, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAX_PRESENCE_AUDIENCE_USERS, parsePresenceAudienceBody } from './presence-audience';

/**
 * The presence-audience question, against `libs/contracts/presence-audience.cases.json` - the one
 * file the gateway's `MAX_PRESENCE_USERS` and both services' validator are pinned to. The module is
 * BYTE-IDENTICAL in chat-delivery-service and social-service (a declared duplicate), so this one
 * spec proves both copies (docs/wiki/test-suite-reform.md section 7.2).
 */
interface ContractCase {
  name: string;
  body: { viewerId?: unknown; userIds?: unknown };
  expected: { viewerId: string; userIds: string[] } | null;
}

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'presence-audience.cases.json'),
    'utf8'
  )
) as { maxUserIds: number; cases: ContractCase[] };

describe('parsePresenceAudienceBody', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads a contract that actually has cases in it', () => {
    expect(CONTRACT.cases.length).toBeGreaterThan(0);
  });

  it('caps at the number the gateway caps at', () => {
    expect(MAX_PRESENCE_AUDIENCE_USERS).toBe(CONTRACT.maxUserIds);
  });

  it.each(CONTRACT.cases.filter((c) => c.expected !== null))('$name', ({ body, expected }) => {
    expect(parsePresenceAudienceBody(body)).toEqual(expected);
  });

  it.each(CONTRACT.cases.filter((c) => c.expected === null))('$name', ({ body }) => {
    expect(() => parsePresenceAudienceBody(body)).toThrow(BadRequestException);
  });

  it('accepts exactly the cap, refuses one more, and counts DISTINCT ids', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
    const max = CONTRACT.maxUserIds;
    expect(parsePresenceAudienceBody({ viewerId: 'v', userIds: ids(max) }).userIds).toHaveLength(
      max
    );
    expect(() => parsePresenceAudienceBody({ viewerId: 'v', userIds: ids(max + 1) })).toThrow(
      BadRequestException
    );
    expect(
      parsePresenceAudienceBody({ viewerId: 'v', userIds: [...ids(max), 'U0'] }).userIds
    ).toHaveLength(max);
  });
});
