import { BadRequestException } from '@nestjs/common';
import {
  BELL_LIMIT_INVALID,
  BELL_PAGE_DEFAULT,
  BELL_PAGE_MAX,
  bellPageLimit,
} from './post-notifications.service';

/**
 * THE BELL'S `?limit=` IS VALIDATED (review of #2965): it used to be `Number(limit)` passed
 * straight to the query, so a large value read a reader's whole history through the per-row
 * visibility check, and garbage reached TypeORM as NaN.
 */
describe('bellPageLimit', () => {
  it('serves the default when no limit is named', () => {
    expect(bellPageLimit(undefined)).toBe(BELL_PAGE_DEFAULT);
    expect(bellPageLimit('')).toBe(BELL_PAGE_DEFAULT);
  });

  it('keeps a whole number in range, and holds the rest to 1..max', () => {
    expect(bellPageLimit('30')).toBe(30);
    expect(bellPageLimit('50')).toBe(BELL_PAGE_MAX);
    expect(bellPageLimit('100000')).toBe(BELL_PAGE_MAX);
    expect(bellPageLimit('0')).toBe(1);
    expect(bellPageLimit('-5')).toBe(1);
  });

  it.each(['abc', '1.5', '1e3', ' 30', '30x', '9999999999', 'NaN'])(
    'refuses %p with a typed 400',
    (raw) => {
      let caught: unknown;
      try {
        bellPageLimit(raw);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as BadRequestException).getResponse()).toMatchObject({
        code: BELL_LIMIT_INVALID,
      });
    }
  );
});
