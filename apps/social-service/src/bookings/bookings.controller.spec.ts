import { BadRequestException } from '@nestjs/common';
import { parseIds } from './bookings.controller';
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
