import { BadRequestException } from '@nestjs/common';
import { BIRTHDAY_DATE_INVALID, isBirthdayDate, parseBirthdayDate } from './birthday-date';
import {
  PROFILE_FIELD_VISIBILITIES,
  PROFILE_FIELD_VISIBILITY_INVALID,
  parseProfileFieldVisibility,
} from './profile-field-visibility';

/**
 * The two parsers every birthday write goes through (docs/wiki/birthdays.md). The table's CHECKs
 * refuse the same dates (`birthdays.integration.spec.ts`); these prove the answer is a typed 400
 * with its code, before any statement runs.
 */
function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (e) {
    if (e instanceof BadRequestException) return (e.getResponse() as { code?: string }).code;
    throw e;
  }
  return undefined;
}

describe('a birthday date', () => {
  it('accepts every day of every month, 29 February included, and nothing else', () => {
    expect(isBirthdayDate(2, 29)).toBe(true);
    expect(isBirthdayDate(12, 31)).toBe(true);
    expect(isBirthdayDate(1, 1)).toBe(true);
    for (const [month, day] of [
      [2, 30],
      [4, 31],
      [6, 31],
      [9, 31],
      [11, 31],
      [0, 1],
      [13, 1],
      [1, 0],
      [1, 32],
      [1.5, 1],
      ['1', 1],
      [null, 1],
    ]) {
      expect(isBirthdayDate(month, day)).toBe(false);
    }
  });

  it('answers a refused date with its code, and an accepted one as numbers', () => {
    expect(parseBirthdayDate(3, 14)).toEqual({ month: 3, day: 14 });
    expect(codeOf(() => parseBirthdayDate(4, 31))).toBe(BIRTHDAY_DATE_INVALID);
    expect(codeOf(() => parseBirthdayDate(undefined, undefined))).toBe(BIRTHDAY_DATE_INVALID);
  });
});

describe('a profile field visibility', () => {
  it('accepts the three choices and refuses anything else with its code', () => {
    for (const choice of PROFILE_FIELD_VISIBILITIES) {
      expect(parseProfileFieldVisibility(choice)).toBe(choice);
    }
    for (const other of ['everyone', 'FOLLOWERS', '', null, 1]) {
      expect(codeOf(() => parseProfileFieldVisibility(other))).toBe(
        PROFILE_FIELD_VISIBILITY_INVALID
      );
    }
  });
});
