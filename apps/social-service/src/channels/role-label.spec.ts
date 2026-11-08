import { BadRequestException } from '@nestjs/common';
import { MAX_ROLE_LABEL_LENGTH, roleLabelOfBody, validateRoleLabel } from './channel.service';

/** The typed code of the 400 a call throws, or undefined when it does not throw one. */
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) return (e.getResponse() as { code?: string }).code;
  }
  return undefined;
};

/**
 * A role's display name is validated like the other community names - trimmed, bounded in the
 * characters a person sees, no control or invisible character - and an empty one is a RESET, not an
 * error. The database-backed behaviour is in `role-label.integration.spec.ts`.
 */
describe('validateRoleLabel', () => {
  it('trims and keeps a name exactly as typed', () => {
    expect(validateRoleLabel('  Présidence ')).toBe('Présidence');
    expect(validateRoleLabel('Bureau des élèves')).toBe('Bureau des élèves');
  });

  it('reads an absent, null or blank name as "none"', () => {
    expect(validateRoleLabel(undefined)).toBeNull();
    expect(validateRoleLabel(null)).toBeNull();
    expect(validateRoleLabel('   ')).toBeNull();
  });

  it('counts characters a person sees, not UTF-16 units', () => {
    expect(validateRoleLabel('a'.repeat(MAX_ROLE_LABEL_LENGTH))).toHaveLength(
      MAX_ROLE_LABEL_LENGTH
    );
    expect(validateRoleLabel('\u{1F3B5}'.repeat(MAX_ROLE_LABEL_LENGTH))).toHaveLength(
      MAX_ROLE_LABEL_LENGTH * 2
    );
    expect(codeOf(() => validateRoleLabel('a'.repeat(MAX_ROLE_LABEL_LENGTH + 1)))).toBe(
      'ROLE_LABEL_INVALID'
    );
  });

  it('refuses control and bidi-override characters and non-text, with a typed code', () => {
    for (const bad of ['a\nb', 'a\tb', 'a‮b', 'a⁧b', 7, {}]) {
      expect(codeOf(() => validateRoleLabel(bad))).toBe('ROLE_LABEL_INVALID');
    }
  });

  it('refuses invisible formatting and separators, so a name of invisibles is not a name', () => {
    const invisibles = [
      '​', // zero-width space
      '‌',
      '‍',
      '‎',
      '‏',
      '؜', // arabic letter mark
      ' ', // line separator
      ' ', // paragraph separator
      '﻿', // byte order mark
      '\u{E0041}', // tag character
    ];
    for (const c of invisibles) {
      expect(codeOf(() => validateRoleLabel(`a${c}b`))).toBe('ROLE_LABEL_INVALID');
      // Alone, the character is either refused outright or - when JavaScript's trim() counts it as
      // whitespace (BOM, U+2028, U+2029) - BLANK, which is a reset: never a non-blank name.
      const alone = (() => {
        try {
          return validateRoleLabel(` ${c}${c} `);
        } catch (e) {
          return e instanceof BadRequestException ? 'refused' : 'other';
        }
      })();
      expect([null, 'refused']).toContain(alone);
    }
  });
});

describe('roleLabelOfBody', () => {
  it('requires the label key: only an explicit null or blank resets', () => {
    for (const body of [{}, undefined, null, 'x', { lable: 'x' }]) {
      expect(codeOf(() => roleLabelOfBody(body))).toBe('ROLE_LABEL_INVALID');
    }
    expect(roleLabelOfBody({ label: null })).toBeNull();
    expect(roleLabelOfBody({ label: '  ' })).toBe('  ');
    expect(roleLabelOfBody({ label: 'Bureau' })).toBe('Bureau');
  });
});
