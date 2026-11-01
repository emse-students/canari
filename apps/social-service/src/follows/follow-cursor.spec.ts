import { BadRequestException } from '@nestjs/common';
import { FOLLOW_CURSOR_INVALID, decodeFollowCursor, encodeFollowCursor } from './follow-cursor';

describe('the follow list cursor', () => {
  const ID = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';

  it.each([
    '2026-10-01 12:00:00',
    '2026-10-01 12:00:00.000123',
    '2026-10-02 12:00:00.5+00',
    '2026-10-02 12:00:00+05:30',
  ])('round-trips the instant %s exactly as PostgreSQL printed it', (at) => {
    expect(decodeFollowCursor(encodeFollowCursor(at, ID))).toEqual({ at, id: ID });
  });

  it('reads an absent or empty cursor as the first page', () => {
    expect(decodeFollowCursor(undefined)).toBeNull();
    expect(decodeFollowCursor('')).toBeNull();
  });

  it.each([
    ['not base64 json', 'zzz'],
    ['an object', Buffer.from(JSON.stringify({ at: 1 })).toString('base64url')],
    ['a date in prose', Buffer.from(JSON.stringify(['yesterday', ID])).toString('base64url')],
    [
      'a quote in the instant',
      Buffer.from(JSON.stringify(["2026-10-01 12:00:00'", ID])).toString('base64url'),
    ],
    [
      'an id that is no uuid',
      Buffer.from(JSON.stringify(['2026-10-01 12:00:00', 'x'])).toString('base64url'),
    ],
    ['an overlong value', 'a'.repeat(500)],
    ['a repeated parameter (an array)', ['a', 'b']],
    ['a number', 42],
  ] as [string, unknown][])('refuses %s with a 400 FOLLOW_CURSOR_INVALID', (_label, raw) => {
    let thrown: unknown;
    try {
      decodeFollowCursor(raw);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      code: FOLLOW_CURSOR_INVALID,
    });
  });
});
