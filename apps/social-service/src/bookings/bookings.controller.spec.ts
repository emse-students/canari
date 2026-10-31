import { BadRequestException } from '@nestjs/common';
import { parseFrom, parseIds } from './bookings.controller';
import { SPACE_BOOKINGS_PAGE } from './bookings.service';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'AAAAAAAA-2222-4333-8444-555555555555';

describe('the `ids` filter of the organiser list', () => {
  it('is absent when not asked, and reads a comma list otherwise, deduplicated and lower-cased', () => {
    expect(parseIds(undefined)).toBeUndefined();
    expect(parseIds(`${A}, ${B},${A}`)).toEqual([A, B.toLowerCase()]);
  });

  it('refuses a malformed id or more than one page, before any query', () => {
    for (const raw of [
      '',
      'x',
      `${A},nope`,
      Array(SPACE_BOOKINGS_PAGE + 1)
        .fill(A)
        .join(','),
    ]) {
      expect(() => parseIds(raw)).toThrow(BadRequestException);
    }
  });
});

describe('the `from` filter of the organiser list (WP-R5)', () => {
  it('is absent when not asked, and reads an instant that names its zone', () => {
    expect(parseFrom(undefined)).toBeUndefined();
    expect(parseFrom('2026-11-02T10:00:00.000Z')).toBe(Date.parse('2026-11-02T10:00:00Z'));
    expect(parseFrom('2026-11-02T11:00:00+01:00')).toBe(Date.parse('2026-11-02T10:00:00Z'));
  });

  it('refuses an instant without a zone, or no instant at all, before any query', () => {
    for (const raw of ['', '2026-11-02T10:00:00', 'tomorrow', '2026-13-45T99:00:00Z']) {
      expect(() => parseFrom(raw)).toThrow(BadRequestException);
    }
  });
});
